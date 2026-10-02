import { agentMain } from "./agent-kit.js";
import { handlers, tools } from "./agent.js";

await agentMain(tools, handlers);
