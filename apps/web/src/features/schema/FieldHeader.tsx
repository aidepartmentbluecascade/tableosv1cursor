import type { FieldDto } from "../../lib/api.ts";

export function FieldHeader({
  field,
  isPrimary,
}: {
  field: FieldDto;
  isPrimary: boolean;
}) {
  return (
    <>
      {field.name}
      {isPrimary ? (
        <span
          style={{
            display: "block",
            fontWeight: 400,
            fontSize: "0.75rem",
            color: "var(--tabula-color-text-muted)",
          }}
        >
          Primary
        </span>
      ) : null}
    </>
  );
}
