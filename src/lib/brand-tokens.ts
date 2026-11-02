/**
 * Vale brand tokens (hackathon version). Single source for the robot's colors
 * and the basics of the brand. Values match the brand guide.
 */
export const BRAND = {
  color: {
    // Brand
    night: "#14224F", // text, dark backgrounds, robot visor
    blue: "#2F5BFF", // main blue, robot body
    cyan: "#18B8E0", // cool turquoise, listening state
    magenta: "#E6329B", // right bar of the logo, alerts
    mist: "#F5F8FF", // light background
    // Light versions, for dark backgrounds
    blueLight: "#8FA9FF",
    cyanLight: "#7FDDEB",
    magentaLight: "#FF6BBE",
    // Soft surfaces
    bluePastel: "#BFD0FF",
    pinkPastel: "#FAC0E0",
    // Robot-only
    bodyLight: "#6A90FF", // top-left of the body gradient
    bodyDark: "#2346C8", // bottom-right of the gradient and the head collar
    antenna: "#FF6BBE", // antenna ball
    antennaError: "#8FA0BF", // antenna ball in the error state
    eye: "#8FE6F2", // eyes and smile
    eyeGlow: "#18B8E0", // blurred glow behind the eyes
  },
  font: {
    wordmark: "'Josefin Sans', sans-serif", // weight 300, the word "vale"
    slogan: "'Cormorant Garamond', serif", // italic, weight 300
    text: "'Hanken Grotesk', sans-serif", // app UI text, weights 400/500/600
  },
  slogan: { es: "Solo dilo.", en: "Just say it." },
} as const;
