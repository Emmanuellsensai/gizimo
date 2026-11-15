// Types for the generated validator (see scripts/gen-validator.mjs).
export interface ValidationError {
  instancePath: string;
  message?: string;
  params?: Record<string, unknown>;
}
declare const validate: {
  (data: unknown): boolean;
  errors?: ValidationError[] | null;
};
export default validate;
export { validate };
