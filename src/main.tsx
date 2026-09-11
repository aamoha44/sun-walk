import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main aria-labelledby="title"><h1 id="title">Sun Walk</h1></main>;
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("The application root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
