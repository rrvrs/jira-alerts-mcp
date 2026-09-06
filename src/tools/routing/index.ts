/** The routing toolset: everything that decides who gets notified. */

import type { AnyToolDefinition } from "../define.js";
import { escalationTools } from "./escalations.js";
import { forwardingTools } from "./forwarding.js";
import { notificationRuleTools, notificationStepTools } from "./notification-rules.js";
import { changeRoutingRuleOrder, routingRuleTools } from "./routing-rules.js";

export const routingTools: AnyToolDefinition[] = [
  ...escalationTools,
  ...routingRuleTools,
  changeRoutingRuleOrder,
  ...forwardingTools,
  ...notificationRuleTools,
  ...notificationStepTools,
];
