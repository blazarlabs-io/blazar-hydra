const Status = {
  INITIALIZING: "INITIALIZING",
  MERGING: "MERGING",
  COMMITTING: "COMMITTING",
  AWAITING: "AWAITING",
  RUNNING: "RUNNING",
  CLOSED: "CLOSED",
  FAILED: "FAILED",
} as const;

const Kind = {
  OPEN_HEAD: "OPEN",
  CLOSE_HEAD: "CLOSE",
} as const;

type Status = keyof typeof Status;
type Kind = keyof typeof Kind;

export { Status, Kind };
