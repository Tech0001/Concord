import icon from "../../../assets/brand/concord-icon.svg";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <img src={icon} alt="" width={26} height={26} />
      {!compact && <span className="brand-name">Concord</span>}
      {compact && <span className="sr-only">Concord</span>}
    </span>
  );
}
