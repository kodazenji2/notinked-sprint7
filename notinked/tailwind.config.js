/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#160F1F",
        ink2: "#1F1830",
        ink3: "#2A2140",
        primary: "#7B6CA6",
        primaryDim: "#5B4A80",
        primaryLight: "#A796C9",
        text: "#E8E5F0",
        muted: "#8B84A0",
        danger: "#C97575",
        warn: "#C9AD75",
      },
    },
  },
  plugins: [],
};
