export type RunState = "start" | "playing" | "over";

export type Snapshot = {
  state: RunState;
  score: number;
  distance: number;
  coins: number;
  combo: number;
  best: number;
  muted: boolean;
  webgl: boolean;
};

export const INITIAL_SNAP: Snapshot = {
  state: "start",
  score: 0,
  distance: 0,
  coins: 0,
  combo: 0,
  best: 0,
  muted: false,
  webgl: true,
};
