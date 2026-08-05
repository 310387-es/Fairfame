import { fieldErrorId } from "@/components/ui/use-action";

/**
 * One field's validation message, under the control it belongs to (W1.5).
 *
 * Rendered with `aria-errormessage` pointing at it from the input, which is
 * what makes a screen reader announce *this* text when focus lands on *that*
 * control — the pairing the toast cannot do, because a toast is about the form
 * and this is about the field.
 *
 * Renders nothing when there is no message rather than an empty element:
 * `aria-errormessage` referencing a blank node announces silence, which reads
 * to a screen-reader user as a control that is invalid for no stated reason.
 */
export function FieldError({ name, message }: { name: string; message: string | undefined }) {
  if (!message) return null;

  return (
    <p id={fieldErrorId(name)} className="text-copy text-state-negative-text">
      {message}
    </p>
  );
}
