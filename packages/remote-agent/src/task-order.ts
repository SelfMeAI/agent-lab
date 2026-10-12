import type { RemoteTask } from "../../contracts/src/remote-agent";

export const unknownTaskTime = "1970-01-01T00:00:00.000Z";

/** Reading a view or replaying history is not new task activity. */
export function latestTaskTime(current: string, incoming?: string): string {
  return incoming && Date.parse(incoming) > Date.parse(current) ? incoming : current;
}

export function sortRemoteTasks(tasks: readonly RemoteTask[]): RemoteTask[] {
  return [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

function mergeTask(previous: RemoteTask | undefined, incoming: RemoteTask): RemoteTask {
  return previous ? { ...incoming, updatedAt: latestTaskTime(previous.updatedAt, incoming.updatedAt) } : incoming;
}

/** The catalog decides membership; older metadata cannot undo live activity. */
export function mergeRemoteTaskCatalog(previous: readonly RemoteTask[], incoming: readonly RemoteTask[]): RemoteTask[] {
  const known = new Map(previous.map(task => [task.id, task]));
  return sortRemoteTasks(incoming.map(task => mergeTask(known.get(task.id), task)));
}

export function upsertRemoteTask(previous: readonly RemoteTask[], incoming: RemoteTask): RemoteTask[] {
  return sortRemoteTasks([...previous.filter(task => task.id !== incoming.id), mergeTask(previous.find(task => task.id === incoming.id), incoming)]);
}
