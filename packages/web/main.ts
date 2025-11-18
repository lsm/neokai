import { App, staticFiles } from "fresh";
import { define } from "./utils.ts";

export const app = new App();

app.use(staticFiles());

// Include file-system based routes
app.fsRoutes();
