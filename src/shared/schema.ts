/** Small JSON-only runtime schemas shared by Worker, browser and contract fixtures. */
export class ContractError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ContractError';
  }
}

export class Schema<T> {
  constructor(readonly read: (input: unknown, path: string) => T) {}
  parse(input: unknown): T { return this.read(input, '$'); }
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: ContractError } {
    try { return { success: true, data: this.parse(input) }; }
    catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return { success: false, error };
    }
  }
  refine(check: (value: T) => boolean, message: string): Schema<T> {
    return new Schema((input, path) => {
      const value = this.read(input, path);
      if (!check(value)) throw new ContractError(path, message);
      return value;
    });
  }
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;

export function object<const S extends Shape>(shape: S): Schema<{ [K in keyof S]: Infer<S[K]> }> {
  return new Schema((input, path) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      throw new ContractError(path, 'Expected a JSON object');
    }
    const record = input as Record<string, unknown>;
    if (Reflect.ownKeys(record).some((key) => typeof key !== 'string'
      || !Object.prototype.hasOwnProperty.call(shape, key))) {
      throw new ContractError(path, 'Unknown property');
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        throw new ContractError(`${path}.${key}`, 'Required property');
      }
      Object.defineProperty(result, key, {
        value: shape[key].read(record[key], `${path}.${key}`), enumerable: true,
      });
    }
    return result as { [K in keyof S]: Infer<S[K]> };
  });
}

export function string(min: number, max: number, pattern?: RegExp): Schema<string> {
  return new Schema((input, path) => {
    if (typeof input !== 'string' || input.length < min || input.length > max
      || (pattern && !pattern.test(input))) throw new ContractError(path, 'Invalid string');
    return input;
  });
}
export function number(min: number, max: number, integer = false): Schema<number> {
  return new Schema((input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max
      || (integer && !Number.isSafeInteger(input))) throw new ContractError(path, 'Invalid number');
    return input;
  });
}
export function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
  return new Schema((input, path) => {
    if (input !== expected) throw new ContractError(path, 'Invalid literal');
    return expected;
  });
}
export function enumeration<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return new Schema((input, path) => {
    if (typeof input !== 'string' || !values.includes(input)) throw new ContractError(path, 'Invalid enum');
    return input as T[number];
  });
}
export const boolean = new Schema<boolean>((input, path) => {
  if (typeof input !== 'boolean') throw new ContractError(path, 'Expected a boolean');
  return input;
});
export function array<T>(item: Schema<T>, min: number, max: number): Schema<T[]> {
  return new Schema((input, path) => {
    if (!Array.isArray(input) || input.length < min || input.length > max) {
      throw new ContractError(path, 'Invalid array length');
    }
    const result: T[] = [];
    for (let i = 0; i < input.length; i++) result.push(item.read(input[i], `${path}[${i}]`));
    return result;
  });
}
export function union<const T extends readonly Schema<unknown>[]>(...schemas: T): Schema<Infer<T[number]>> {
  return new Schema((input, path) => {
    for (const schema of schemas) {
      try { return schema.read(input, path) as Infer<T[number]>; }
      catch (error) { if (!(error instanceof ContractError)) throw error; }
    }
    throw new ContractError(path, 'No matching variant');
  });
}
export const nullable = <T>(schema: Schema<T>) => union(schema, literal(null));
