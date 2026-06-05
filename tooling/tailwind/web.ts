import type { Config } from "tailwindcss";
import forms from "@tailwindcss/forms";
import scrollbar from "tailwind-scrollbar";

export default {
  content: ["./src/**/*.tsx"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-plus-jakarta-sans), Plus Jakarta Sans"],
      },
      fontSize: {
        sm: "0.8rem",
      },
      boxShadow: {
        "3xl-dark": "0px 16px 70px rgba(0, 0, 0, 0.5)",
        "3xl-light":
          "rgba(0, 0, 0, 0.12) 0px 4px 30px, rgba(0, 0, 0, 0.04) 0px 3px 17px, rgba(0, 0, 0, 0.04) 0px 2px 8px, rgba(0, 0, 0, 0.04) 0px 1px 1px",
      },
      animation: {
        "border-spin": "border-spin 4s linear infinite",
        "fade-down": "fade-down 0.5s ease-out",
        "fade-in": "fade-in 0.5s ease-out",
        scroll: "scroll 40s linear infinite",
      },

      keyframes: {
        "border-spin": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        "fade-down": {
          "0%": {
            opacity: "0",
            transform: "translateY(-20px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0)",
          },
        },
        "fade-in": {
          "0%": {
            opacity: "0",
          },
          "100%": {
            opacity: "1",
          },
        },
        scroll: {
          "0%": {
            transform: "translateX(0)",
          },
          "100%": {
            transform: "translateX(calc(-50% - 1.5rem))",
          },
        },
      },
      colors: {
        // Maven / Gotham-style command-center ramp:
        // very dark cool graphite for surfaces, desaturated slate for chrome,
        // bright cool grey for primary text. Keeps the existing token names so
        // every dark:bg-/border-/text-dark-* utility re-skins automatically.
        "dark-50": "#06090E",
        "dark-100": "#0B1118",
        "dark-200": "#131C26",
        "dark-300": "#1A2530",
        "dark-400": "#1F2D3A",
        "dark-500": "#2A3845",
        "dark-600": "#3B4A58",
        "dark-700": "#54667A",
        "dark-800": "#7C8B9C",
        "dark-900": "#9AA8B8",
        "dark-950": "#C2CBD6",
        "dark-1000": "#E6EBF1",
        "light-50": "hsl(0deg 0% 98.8%)",
        "light-100": "hsl(0deg 0% 97.3%)",
        "light-200": "hsl(0deg 0% 95.3%)",
        "light-300": "hsl(0deg 0% 92.9%)",
        "light-400": "hsl(0deg 0% 91%)",
        "light-500": "hsl(0deg 0% 88.6%)",
        "light-600": "hsl(0deg 0% 85.9%)",
        "light-700": "hsl(0deg 0% 78%)",
        "light-800": "hsl(0deg 0% 56.1%)",
        "light-900": "hsl(0deg 0% 52.2%)",
        "light-950": "hsl(0deg 0% 43.5%)",
        "light-1000": "hsl(0deg 0% 9%)",
      },
      screens: {
        "2xl": "1600px",
      },
    },
  },
  plugins: [forms, scrollbar],
} satisfies Config;
