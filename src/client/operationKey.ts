import { UuidSchema } from '../shared/contracts';

export interface OperationKeyScope {
  readonly key: string;
  complete(): void;
}

export function createOperationKeyScope(createId: () => string = () => crypto.randomUUID()): OperationKeyScope {
  let key: string | undefined;

  return {
    get key() {
      key ??= UuidSchema.parse(createId());
      return key;
    },
    complete() {
      key = undefined;
    },
  };
}
