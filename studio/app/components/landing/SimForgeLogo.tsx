export default function SimForgeLogo({ size = 28 }: { size?: number }) {
  // Original viewBox is 164x243; compute height from width
  const aspect = 243 / 164;
  const h = Math.round(size * aspect);

  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 164 243"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* upper S arm */}
      <path
        d="m147 53.17-60.27-41.15-70.64 49.66v58.38l62.73 42.75 20.12-14-60.27-39.55v-33.46l48.06-33.19 60.48 40.58-0.21-30.02z"
        fill="currentColor"
      />
      {/* lower S arm */}
      <path
        d="m147 120.8-62.26-40.94-22.06 14 62.26 40.55v32.42l-47.89 32.42-61.92-41.65v28.89l61.56 41.86 70.31-49.67v-57.88z"
        fill="currentColor"
      />
    </svg>
  );
}
