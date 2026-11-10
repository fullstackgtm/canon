import type { ControlPlane } from "../../dealPlays";
import { stateForReader } from "../plays/state.ts";

/** The plane already applies caller field, people, activity and inbox rules. Never persist this context. */
export function dealChatContext(plane: Pick<ControlPlane, "streamId" | "deal" | "brief" | "state" | "stateHidden" | "people" | "touches">) {
  return {
    record: { object: "deal", id: plane.streamId, title: plane.deal.name },
    sections: [
      { deal: plane.deal, brief: plane.brief },
      { ...stateForReader(plane.state ?? null, { restricted: plane.stateHidden, mayRead: () => true }), note: "Live caller-visible deal state. Missing or clipped evidence is not established." },
      { people: plane.people.slice(0, 20), totalPeople: plane.people.length },
      { recentTouches: plane.touches.slice(0, 15), totalTouches: plane.touches.length },
    ],
  };
}
