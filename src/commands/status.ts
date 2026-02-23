import { discoverPlan } from "../lib/plan";
import * as stateStore from "../lib/state";
import * as ui from "../lib/ui";

export async function runStatus(opts: { fromBranch?: string } = {}): Promise<void> {
  const { commonDir, fromBranch, plan, graph } = await discoverPlan({ fromBranch: opts.fromBranch });

  ui.printInfo(`${ui.styleLabel("From branch:")} ${ui.styleBranch(fromBranch, "current")}`);
  ui.printStatusTree(graph, plan, { fromBranch });

  const state = await stateStore.loadState(commonDir);
  if (!state) {
    ui.printInfo(`${ui.styleLabel("Checkpoint:")} none`);
    return;
  }

  ui.printInfo(ui.styleLabel("Checkpoint:"));
  ui.printInfo(`- startedAt: ${state.startedAt}`);
  ui.printInfo(`- rootBranch: ${ui.styleBranch(state.rootBranch, "root")}`);
  ui.printInfo(`- completed: ${state.completed.length}/${state.executionOrder.length}`);
  if (state.failedAt) {
    ui.printWarning(`- failedAt: ${state.failedAt}`);
  }
  if (state.lastError) {
    ui.printWarning(`- lastError: ${state.lastError}`);
  }
}
