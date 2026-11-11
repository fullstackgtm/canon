# The recipe runtime (services/recipe-runtime) as the self-hosted image runs it: workerd alone, on loopback, with the
# Worker that Dockerfile.selfhost bundles next to this file. Module and recipe code runs in the isolates its LOADER
# starts, which have no network and no env. The secret comes from workerd's own environment, never from this file.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "runtime", worker = .runtime) ],
  sockets = [ (name = "http", address = "127.0.0.1:8790", http = (), service = "runtime") ],
);

const runtime :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "RECIPE_RUNTIME_SECRET", fromEnvironment = "RECIPE_RUNTIME_SECRET"),
  ],
);
