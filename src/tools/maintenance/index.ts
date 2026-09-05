/** The maintenance toolset. */

import type { AnyToolDefinition } from "../define.js";
import { cancelMaintenance, maintenanceTools } from "./maintenance.js";

export const maintenanceWindowTools: AnyToolDefinition[] = [...maintenanceTools, cancelMaintenance];
