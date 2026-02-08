import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class', // Enable manual dark mode toggling
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        theme: {
          bg: 'var(--theme-bg)',
          text: 'var(--theme-text)',
          border: 'var(--theme-border)',
        }
      }
    },
  },
  plugins: [
    typography,
  ],
}
