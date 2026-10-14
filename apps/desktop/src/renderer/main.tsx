import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<App />);
