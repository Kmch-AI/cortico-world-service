import type { Logger } from 'cortico/core/types.ts';

export const quietLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child() { return this; },
};
