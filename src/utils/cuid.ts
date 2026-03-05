import { createId } from "@paralleldrive/cuid2";

export function newCuid(): string {
  return createId();
}
