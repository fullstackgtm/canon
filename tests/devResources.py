import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


RUNNER = Path(__file__).resolve().parents[1] / "scripts/dev/resource-runner.py"
SELF = Path(__file__).resolve()


def denied_probe():
    import errno
    import runpy

    killpg = os.killpg

    def signal_group(pgid, sig):
        if sig == 0:
            raise PermissionError(errno.EPERM, "signal-zero probe denied")
        return killpg(pgid, sig)

    os.killpg = signal_group
    sys.argv = [str(RUNNER), *sys.argv[2:]]
    runpy.run_path(str(RUNNER), run_name="__main__")


def detached_worker():
    events = Path(sys.argv[2])
    subprocess.Popen([sys.executable, str(SELF), "worker", *sys.argv[2:], "ignore"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 3
    while not events.exists():
        assert time.monotonic() < deadline
        time.sleep(0.005)


def worker():
    events, duration = Path(sys.argv[2]), sys.argv[3]

    def record(kind):
        with events.open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.write(json.dumps([kind, os.getpid(), time.time_ns(), str(Path.cwd())]) + "\n")

    if "ignore" in sys.argv[4:]:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record("start")
    if "pair" in sys.argv[4:]:
        deadline = time.monotonic() + 3
        while sum(json.loads(line)[0] == "start" for line in events.read_text().splitlines()) < 2:
            assert time.monotonic() < deadline
            time.sleep(0.005)
    if duration.startswith("until:"):
        while not Path(duration[6:]).exists():
            time.sleep(0.01)
    else:
        time.sleep(float(duration))
    record("end")


def legacy():
    home, ready, proceed, events = map(Path, sys.argv[2:6])
    sys.path.insert(0, str(RUNNER.parent))
    import importlib
    runner = importlib.import_module("resource-runner")
    owner = {"resource": "check", "root": str(Path.cwd()), "pid": os.getpid(), "started": time.time()}
    fds = [runner.open_lock(home / "check-1.lock"), runner.open_lock(runner.root_lock(home, "check", Path.cwd()))]
    for fd in fds:
        fcntl.flock(fd, fcntl.LOCK_EX)
        runner.write_owner(fd, owner)
    ready.touch()
    while not proceed.exists():
        time.sleep(0.01)
    env = {**os.environ, "CANONCRM_RESOURCE_CHECK_LEASE": json.dumps({"slot": 1, "fds": fds, "owner": owner})}
    result = subprocess.run([sys.executable, str(RUNNER), "check", "--", sys.executable, str(SELF), "worker", str(events), "0.01"], env=env, pass_fds=fds)
    assert result.returncode == 0


def suite():
    with tempfile.TemporaryDirectory(prefix="canoncrm-resources-") as directory:
        base = Path(directory)
        env = {"PATH": os.environ["PATH"], "HOME": str(base), "TMPDIR": str(base),
               "CANONCRM_DEVSTACK_HOME": str(base / "registry"), "PYTHONDONTWRITEBYTECODE": "1"}
        roots = [base / f"root-{i}" for i in range(12)]
        for root in roots:
            root.mkdir()
        processes = []
        releases = []
        orphan_groups = []

        def held(name):
            release = base / name
            releases.append(release)
            return "until:" + str(release), release

        def start(root, resource="check", command=None, extra_env=None, kind="check"):
            proc = subprocess.Popen([sys.executable, str(RUNNER), resource, "--kind", kind, "--", *(command or [])],
                                    cwd=root, env=extra_env or env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            processes.append(proc)
            return proc

        def call(root, *args, extra_env=None):
            return subprocess.run([sys.executable, str(RUNNER), *args], cwd=root, env=extra_env or env,
                                  capture_output=True, text=True, timeout=10)

        def finish(proc, expected=0):
            _, err = proc.communicate(timeout=10)
            assert proc.returncode == expected, (proc.returncode, expected, err)

        def launch(root, events, duration=0.035, resource="check", ignore=False):
            return start(root, resource, [sys.executable, str(SELF), "worker", str(events), str(duration), *(["ignore"] if ignore else [])])

        def wait_for(predicate):
            deadline = time.monotonic() + 10
            while not predicate():
                assert time.monotonic() < deadline, "timed out awaiting worker admission"
                time.sleep(0.005)

        def rows(events):
            return [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []

        def counts(resource="check"):
            return json.loads(call(roots[0], "status").stdout)[resource]

        def peak(events):
            active, maximum = set(), 0
            for kind, pid, _when, _root in sorted(rows(events), key=lambda row: row[2]):
                if kind == "start":
                    active.add(pid)
                    maximum = max(maximum, len(active))
                else:
                    active.remove(pid)
            assert not active
            return maximum

        try:
            assert json.loads(call(roots[0], "profile").stdout)["name"] == "interactive"
            assert json.loads(call(roots[0], "profile", extra_env={**env, "CI": "true"}).stdout)["name"] == "interactive"
            assert json.loads(call(roots[0], "profile", extra_env={**env, "GITHUB_ACTIONS": "true"}).stdout)["name"] == "throughput"
            assert call(roots[0], "profile", "invalid").returncode == 2
            events = base / "interactive.jsonl"
            for proc in [launch(root, events, 0.02) for root in roots[:3]]:
                finish(proc)
            assert peak(events) == 1
            assert counts()["limit"] == 1 and counts("stack")["limit"] == 2
            output = base / "environment.json"
            code = "import json,os,pathlib;pathlib.Path(os.environ['PROOF_PATH']).write_text(json.dumps({k:os.environ.get(k) for k in ['CANONCRM_CHECK_SERIAL','CANONCRM_TEST_CONCURRENCY','GOMAXPROCS']}|{'nice':os.getpriority(os.PRIO_PROCESS,0)}))"
            finish(start(roots[0], command=[sys.executable, "-c", code], extra_env={**env, "PROOF_PATH": str(output)}))
            proof = json.loads(output.read_text())
            assert proof["CANONCRM_CHECK_SERIAL"] == "1" and proof["CANONCRM_TEST_CONCURRENCY"] == "1" and proof["GOMAXPROCS"] == "2" and proof["nice"] >= 10, proof
            print("interactive default, CI distinction and inherited CPU settings")

            launcher = RUNNER.with_name("node-test.mjs")
            fixtures = [base / f"launcher-{index}.test.mjs" for index in range(2)]
            fixture = "import {appendFileSync} from 'node:fs'; import {test} from 'node:test'; test('bounded files', async()=>{ const record=(kind)=>appendFileSync(process.env.EVENTS,JSON.stringify([kind,process.pid,Number(process.hrtime.bigint()),process.cwd()])+'\\n'); record('start'); await new Promise(r=>setTimeout(r,100)); record('end'); });"
            for path in fixtures:
                path.write_text(fixture)
            test_command = ["node", str(launcher), "--default-concurrency=2", "--", *map(str, fixtures)]
            events = base / "launcher-interactive.jsonl"
            finish(start(roots[0], command=test_command, extra_env={**env, "EVENTS": str(events)}))
            assert peak(events) == 1

            duration, release_check = held("release-remote-check")
            holder = launch(roots[0], base / "remote-check.jsonl", duration)
            wait_for(lambda: (base / "remote-check.jsonl").exists())
            duration, release_remote = held("release-remote-first")
            first = launch(roots[0], base / "remote-first.jsonl", duration, "remote")
            wait_for(lambda: (base / "remote-first.jsonl").exists())
            second = launch(roots[1], base / "remote-second.jsonl", 0.01, "remote")
            wait_for(lambda: len(counts("remote")["queue"]) == 1)
            assert counts()["active"] == 1 and counts("remote")["active"] == 1
            assert not (base / "remote-second.jsonl").exists()
            release_remote.touch(); finish(first); finish(second)
            release_check.touch(); finish(holder)
            assert counts("remote")["active"] == 0
            print("remote admission is independently bounded and runs beside a local check")

            duration, release = held("release-order")
            holder = launch(roots[0], base / "order-holder.jsonl", duration)
            wait_for(lambda: (base / "order-holder.jsonl").exists())
            events = base / "ordered.jsonl"
            command = [sys.executable, str(SELF), "worker", str(events), "0.01"]
            full = start(roots[1], command=command, kind="full")
            wait_for(lambda: len(counts()["queue"]) == 1)
            duplicate = start(roots[1], command=command, kind="full")
            _, err = duplicate.communicate(timeout=5)
            assert duplicate.returncode == 75 and "no second check" in err
            target = start(roots[2], command=command, kind="target")
            wait_for(lambda: len(counts()["queue"]) == 2)
            queued = counts()["queue"]
            assert [job["kind"] for job in queued] == ["target", "full"]
            assert all(job["waitSeconds"] >= 0 and job["reason"] == "capacity" for job in queued)
            release.touch()
            finish(target); finish(full); finish(holder)
            assert [row[3] for row in rows(events) if row[0] == "start"] == [str(roots[2]), str(roots[1])]

            duration, release = held("release-aging")
            holder = launch(roots[0], base / "aging-holder.jsonl", duration)
            wait_for(lambda: (base / "aging-holder.jsonl").exists())
            events = base / "aging.jsonl"
            command = [sys.executable, str(SELF), "worker", str(events), "0.01"]
            full = start(roots[1], command=command, kind="full")
            wait_for(lambda: len(counts()["queue"]) == 1)
            job = counts()["queue"][0]
            path = base / "registry/resources/queue" / f"{job['jobId']}.json"
            value = json.loads(path.read_text()); value["queued"] -= 61
            temporary = path.with_suffix(".fixture"); temporary.write_text(json.dumps(value)); temporary.replace(path)
            target = start(roots[2], command=command, kind="generate")
            wait_for(lambda: len(counts()["queue"]) == 2)
            assert counts()["queue"][0]["kind"] == "full"
            dead = start(roots[3], command=command, kind="target")
            wait_for(lambda: len(counts()["queue"]) == 3)
            dead.kill(); assert dead.wait(timeout=2) == -signal.SIGKILL
            wait_for(lambda: len(counts()["queue"]) == 2)
            release.touch()
            finish(holder); finish(full); finish(target)
            assert [row[3] for row in rows(events) if row[0] == "start"] == [str(roots[1]), str(roots[2])]
            print("targeted priority, FIFO aging, pending-full rejection and dead waiter removal")

            home = base / "registry/resources"
            ready, proceed, events = base / "legacy-ready", base / "legacy-proceed", base / "legacy.jsonl"
            old = subprocess.Popen([sys.executable, str(SELF), "legacy", str(home), str(ready), str(proceed), str(events)], cwd=roots[0], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            processes.append(old)
            wait_for(ready.exists)
            assert counts()["active"] == 1 and counts()["legacyActive"] == 1
            duration, release = held("release-legacy-new")
            new_events = base / "legacy-new.jsonl"
            pending = launch(roots[1], new_events, duration)
            wait_for(lambda: len(counts()["queue"]) == 1)
            assert not new_events.exists()
            proceed.touch(); finish(old)
            wait_for(new_events.exists)
            release.touch(); finish(pending)
            assert len(rows(events)) == 2
            print("legacy slot 1 counts against interactive admission and remains valid for inheritance")

            events = base / "interactive-stacks.jsonl"
            duration, release = held("release-interactive-stacks")
            stacks = [launch(root, events, duration, "stack") for root in roots[:2]]
            wait_for(lambda: len(rows(events)) == 2)
            finish(launch(roots[2], events, 0.01, "stack"), 75)
            release.touch()
            for proc in stacks:
                finish(proc)
            print("interactive admits two stacks and refuses a third")

            assert call(roots[0], "profile", "throughput").returncode == 0
            assert counts()["limit"] == 2 and counts("stack")["limit"] == 4

            events = base / "launcher-throughput.jsonl"
            finish(start(roots[0], command=test_command, extra_env={**env, "EVENTS": str(events)}))
            assert peak(events) == 2
            print("shared Node launcher honors interactive concurrency and throughput defaults")
            duration, release = held("release-busy-root")
            holder = launch(roots[0], base / "busy-holder.jsonl", duration)
            wait_for(lambda: (base / "busy-holder.jsonl").exists())
            pending = launch(roots[0], base / "busy-pending.jsonl", 0.01)
            wait_for(lambda: len(counts()["queue"]) == 1)
            assert counts()["queue"][0]["reason"] == "worktree busy"
            other = launch(roots[1], base / "busy-other.jsonl", 0.01)
            finish(other)
            assert not (base / "busy-pending.jsonl").exists()
            release.touch(); finish(holder); finish(pending)
            print("queue skips a busy worktree without blocking another root")

            events = base / "concurrent.jsonl"
            workers = [start(root, command=[sys.executable, str(SELF), "worker", str(events), "0.035", "pair"]) for root in roots[:10]]
            for proc in workers:
                finish(proc)
            assert peak(events) == 2, rows(events)
            assert len(rows(events)) == 20
            assert counts()["active"] == 0
            print("10 workers capped at 2")

            events = base / "serial.jsonl"
            workers = [launch(roots[0], events, 0.02) for _ in range(3)]
            for proc in workers:
                finish(proc)
            assert peak(events) == 1
            assert call(roots[0], "active-check").returncode == 1
            assert (roots[0] / ".devstack/activity").is_file()
            before = (roots[0] / ".devstack/activity").stat().st_mtime_ns
            assert call(roots[0], "touch").returncode == 0
            assert (roots[0] / ".devstack/activity").stat().st_mtime_ns >= before
            print("same root serialized; activity and active-check work")

            duration, _release = held("release-waiting")
            holder = launch(roots[0], base / "waiting.jsonl", duration)
            wait_for(lambda: (base / "waiting.jsonl").exists())
            queued = launch(roots[0], base / "never-started.jsonl")
            assert queued.stderr.readline()
            queued.terminate()
            finish(queued, 143)
            holder.send_signal(signal.SIGINT)
            finish(holder, 130)
            assert not (base / "never-started.jsonl").exists()

            events = base / "nested.jsonl"
            import shlex
            command = " ".join(shlex.quote(arg) for arg in [sys.executable, str(RUNNER), "check", "--", sys.executable, str(SELF), "worker", str(events), "0.01"])
            (roots[0] / "package.json").write_text(json.dumps({"scripts": {"test": command, "build": command}}))
            duration, _release = held("release-blocker")
            blocker = launch(roots[1], base / "blocker.jsonl", duration)
            wait_for(lambda: (base / "blocker.jsonl").exists())
            nested = start(roots[0], command=["bash", "-c", "npm test --silent && npm run build --silent"])
            finish(nested)
            assert len(rows(events)) == 4
            assert blocker.poll() is None
            blocker.terminate()
            finish(blocker, 143)
            events = base / "forged.jsonl"
            duration, release = held("release-forged")
            holder = launch(roots[0], events, duration)
            wait_for(lambda: events.exists())
            owner = counts()["owners"][0]
            forged_env = {**env, "CANONCRM_RESOURCE_CHECK_LEASE": json.dumps({"slot": 0, "fds": [999, 998], "owner": owner})}
            forged = start(roots[0], command=[sys.executable, str(SELF), "worker", str(events), "0.01"], extra_env=forged_env)
            finish(forged, 75)
            release.touch()
            finish(holder)
            assert peak(events) == 1
            print("nested npm test/build reuse the lease; forged inheritance is refused")

            finish(start(roots[0], command=[sys.executable, str(RUNNER), "check", "--", "/usr/bin/true"]))

            finish(start(roots[0], command=[sys.executable, "-c", "raise SystemExit(23)"]), 23)
            finish(start(roots[0], command=["/nonexistent/canoncrm-test-command"]), 127)
            events = base / "cancel.jsonl"
            duration, _release = held("release-cancel")
            cancelled = start(roots[0], command=["bash", "-c", '"$@" & wait', "bash", sys.executable, str(SELF), "worker", str(events), duration, "ignore"])
            wait_for(lambda: events.exists())
            assert call(roots[0], "active-check").returncode == 0
            cancelled.terminate()
            finish(cancelled, 143)
            state = subprocess.run(["ps", "-p", str(rows(events)[0][1]), "-o", "stat="], capture_output=True, text=True)
            assert not state.stdout.strip() or state.stdout.strip().startswith("Z")
            assert len(rows(events)) == 1
            assert counts()["active"] == 0
            print("exit propagation and cancellation retain admission through child termination")

            def probe_command(command, expected=0):
                proc = subprocess.Popen([sys.executable, str(SELF), "denied-probe", "check", "--", *command],
                                        cwd=roots[0], env=env, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, text=True)
                processes.append(proc)
                finish(proc, expected)

            probe_command([sys.executable, "-c", "pass"])
            probe_command([sys.executable, "-c", "raise SystemExit(23)"], 23)
            events = base / "denied-probe-orphan.jsonl"
            duration, _release = held("release-denied-probe-orphan")
            probe_command([sys.executable, str(SELF), "detach", str(events), duration])
            state = subprocess.run(["ps", "-p", str(rows(events)[0][1]), "-o", "stat="], capture_output=True, text=True)
            assert not state.stdout.strip() or state.stdout.strip().startswith("Z")
            assert len(rows(events)) == 1
            assert counts()["active"] == 0
            print("denied signal-zero probes preserve child exits and live-descendant cleanup")

            events = base / "killed.jsonl"
            duration, release = held("release-killed")
            killed = start(roots[0], command=["bash", "-c", '"$@" & wait', "bash", sys.executable, str(SELF), "worker", str(events), duration])
            wait_for(lambda: events.exists())
            killed.kill()
            assert killed.wait(timeout=2) == -signal.SIGKILL
            assert counts()["active"] == 1
            assert call(roots[0], "active-check").returncode == 0
            other = launch(roots[1], events, 0.08)
            queued = launch(roots[2], events, 0.01)
            finish(other)
            finish(queued)
            release.touch()
            wait_for(lambda: len(rows(events)) == 6)
            assert peak(events) == 2
            assert counts()["active"] == 0
            print("SIGKILL wrapper leaves child holding its slot")

            events = base / "orphan-nested.jsonl"
            ready = base / "orphan-ready"
            proceed = base / "orphan-proceed"
            finished = base / "orphan-finished"
            orphan = start(roots[0], command=["bash", "-c",
                'echo "$$" > "$1"; while [ ! -f "$2" ]; do sleep 0.01; done; '
                'npm test --silent; echo "$?" > "$3"',
                "orphan-test", str(ready), str(proceed), str(finished)])
            wait_for(ready.exists)
            orphan_groups.append(int(ready.read_text()))
            orphan.kill()
            assert orphan.wait(timeout=2) == -signal.SIGKILL
            proceed.touch()
            wait_for(finished.exists)
            assert finished.read_text().strip() in ("0", "75")
            wait_for(lambda: counts()["active"] == 0)
            print("nested npm after wrapper SIGKILL reuses surviving FDs or fails without deadlock")

            events = base / "stacks.jsonl"
            duration, _release = held("release-stacks")
            stacks = [launch(root, events, duration, "stack") for root in roots[:4]]
            wait_for(lambda: len(rows(events)) == 4)
            assert counts("stack")["active"] == 4
            refused = launch(roots[4], events, 0.01, "stack")
            finish(refused, 75)
            duplicate = launch(roots[0], events, 0.01, "stack")
            finish(duplicate, 75)
            for proc in stacks:
                proc.terminate()
                finish(proc, 143)
            assert counts("stack")["active"] == 0
            assert len(rows(events)) == 4
            print("4 stack slots; fifth and duplicate root fail fast")
        finally:
            for release in releases:
                release.touch()
            for group in orphan_groups:
                try:
                    os.killpg(group, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for proc in processes:
                if proc.poll() is None:
                    proc.terminate()
            for proc in processes:
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "denied-probe":
        denied_probe()
    elif len(sys.argv) > 1 and sys.argv[1] == "detach":
        detached_worker()
    elif len(sys.argv) > 1 and sys.argv[1] == "worker":
        worker()
    elif len(sys.argv) > 1 and sys.argv[1] == "legacy":
        legacy()
    else:
        def cancel(_sig, _frame):
            raise SystemExit(143)
        signal.signal(signal.SIGTERM, cancel)
        started = time.monotonic()
        suite()
        print(f"resource runner integration duration {time.monotonic() - started:.3f}s")
