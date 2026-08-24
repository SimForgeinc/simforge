/** Monochrome traffic light icon matching Lucide conventions (24x24, stroke-based). */
export function TrafficLightIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Body */}
      <rect x="7" y="2" width="10" height="20" rx="2" />
      {/* Lights */}
      <circle cx="12" cy="7" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="17" r="2" />
      {/* Side arms */}
      <line x1="7" y1="7" x2="4" y2="5" />
      <line x1="17" y1="7" x2="20" y2="5" />
    </svg>
  );
}
