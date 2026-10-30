import { bhd } from "../format.js";

/**
 * A BHD amount, rendered from the shared `bhd()` formatter (itself
 * `@filspay/money`'s `formatBhd`). This component only *splits the string
 * that formatter returns* so the three fils digits can be set a shade
 * lighter — it never computes, rounds or rescales anything.
 */
export function Money({ fils, size = "md" }: { fils: number; size?: "md" | "lg" }) {
  const text = bhd(fils); // e.g. "12.750 BHD" or "-1.500 BHD"
  const [amount = text, unit = ""] = text.split(" ");
  const dot = amount.indexOf(".");
  const whole = dot === -1 ? amount : amount.slice(0, dot + 1);
  const fraction = dot === -1 ? "" : amount.slice(dot + 1);
  return (
    <span className={size === "lg" ? "ui-money ui-money-lg" : "ui-money"}>
      {whole}
      <span className="ui-money-fils">{fraction}</span>
      {unit ? <span className="ui-money-unit"> {unit}</span> : null}
    </span>
  );
}
