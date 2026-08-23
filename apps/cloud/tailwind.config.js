import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    // Sharp-corner mandate: the full radius scale (not just the shadcn
    // tokens) resolves to 0 so every rounded-* utility is inert at the
    // source. globals.css carries the matching runtime reset for inline
    // styles and third-party CSS.
    borderRadius: {
      none: "0",
      DEFAULT: "0",
      sm: "0",
      md: "0",
      lg: "0",
      xl: "0",
      "2xl": "0",
      "3xl": "0",
      full: "0",
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Traffic-signal lamp colours. Registered with `<alpha-value>` because
        // the timeline lane needs the same colour at two opacities — an authored
        // band is solid, a baseline band showing the map's own timing through an
        // uncovered gap is faint — and `bg-signal-green/30` is the only way to
        // express that without a second token per state.
        signal: {
          green: "hsl(var(--signal-green) / <alpha-value>)",
          yellow: "hsl(var(--signal-yellow) / <alpha-value>)",
          red: "hsl(var(--signal-red) / <alpha-value>)",
          off: "hsl(var(--signal-off) / <alpha-value>)",
          unknown: "hsl(var(--signal-unknown) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // The two below-background list surfaces. See the token comment in
        // globals.css: they are deliberately darker than `background`.
        "surface-deep": "hsl(var(--surface-deep))",
        "surface-raised": "hsl(var(--surface-raised))",
        editor: {
          accent: "#E8E044",
          bg: "#0a0a0a",
          panel: "#111113",
          panel2: "#18181b",
          line: "rgba(255,255,255,0.08)",
          text: "#f2f2f2",
          muted: "#9a9a9a",
        },
      },
      // The editor's uppercase meta labels ("ACTOR LIBRARY", "INSPECTOR") are
      // tracked out well past Tailwind's built-in scale, which stops at
      // `tracking-widest` (0.1em). Named steps replace the arbitrary
      // `tracking-[0.14em]`…`tracking-[0.22em]` values the surfaces were
      // written with, so the rhythm is one vocabulary rather than per-file
      // guesses.
      letterSpacing: {
        meta: "0.14em",
        "meta-wide": "0.16em",
        "meta-wider": "0.18em",
        "meta-widest": "0.22em",
      },
      // Two sizes below `text-xs` (12px). Readouts, provenance rows and
      // capability chips need them; nothing else in the product does, which is
      // why they were inlined as `text-[11px]`/`text-[10px]`.
      fontSize: {
        meta: ["0.6875rem", { lineHeight: "1rem" }],
        micro: ["0.625rem", { lineHeight: "0.875rem" }],
      },
      // Editor shell geometry. The rails are fixed-width by design — the canvas
      // takes the remainder — and both widths step up at `xl`. Naming them
      // keeps the two rails and the timeline dock's three columns aligned to
      // the same measure instead of repeating `w-[220px]`/`w-[292px]`.
      spacing: {
        "editor-rail": "13.75rem",
        "editor-rail-xl": "18.25rem",
        "editor-inspector": "16.25rem",
        "editor-inspector-xl": "20rem",
        "editor-detail": "26.25rem",
        "editor-shell": "38.75rem",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        heavy: ["var(--font-heavy)", "system-ui", "sans-serif"],
        // Instrument-panel labels and counters. `font-mono` is the code face;
        // this one exists so a meta label never has to name a font inline.
        meta: ["var(--font-meta)", "ui-monospace", "monospace"],
      },
      // The meta tracking scale. `font-meta` is only legible uppercase at these
      // widths, and these steps are exactly the values the list and editor chrome
      // used as arbitrary `tracking-[0.18em]` values. The wide half of the scale
      // is named to match the editor shell, which established it across its own
      // surfaces; `-tight`/`-tighter` extend it downwards for the denser labels.
      letterSpacing: {
        "meta-narrow": "0.1em",
        "meta-tight": "0.12em",
        meta: "0.14em",
        "meta-wide": "0.16em",
        "meta-wider": "0.18em",
        "meta-widest": "0.22em",
      },
      // Meta label sizes, shared with the editor shell so a 10px counter and a
      // 10px rail label cannot drift apart.
      fontSize: {
        meta: ["0.6875rem", { lineHeight: "1rem" }],
        micro: ["0.625rem", { lineHeight: "0.875rem" }],
      },
      transitionTimingFunction: {
        expressive: "cubic-bezier(0.16, 1, 0.3, 1)",
        snappy: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.5s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
