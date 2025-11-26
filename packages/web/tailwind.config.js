/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        'dark': {
          '950': '#0a0a0b',
          '900': '#111113',
          '850': '#18181b',
          '800': '#1f1f23',
          '700': '#2a2a30',
          '600': '#3a3a42',
        }
      },
    },
  },
  plugins: [],
}