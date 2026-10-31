export type PeopleFilter = "all" | "queued" | "sent";

type Person = {
  state: string;
  lastSentAt: number | null;
  position: number | null;
};

export function linkedinPeople<T extends Person>(people: readonly T[], filter: PeopleFilter): T[] {
  return people
    .filter((person) => filter === "all" || (filter === "sent" ? person.lastSentAt !== null : person.state === "queued"))
    .sort((a, b) => {
      if (a.lastSentAt !== null || b.lastSentAt !== null) {
        if (a.lastSentAt === null) return 1;
        if (b.lastSentAt === null) return -1;
        return b.lastSentAt - a.lastSentAt;
      }
      return (a.position ?? Infinity) - (b.position ?? Infinity);
    });
}
