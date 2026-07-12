import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DemoLocalStoragePersistenceAdapter } from "./persistence/localStorage";
import "./styles.css";

const persistence = new DemoLocalStoragePersistenceAdapter(window.localStorage);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App persistence={persistence} />
  </React.StrictMode>
);
