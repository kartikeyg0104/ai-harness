import type { Checkpoint, DispatchRecord, LoopState, Mission } from "./types";

export interface LoopControl {
  mission(id: string): Mission;
  transitionLoop(id: string, next: LoopState): Mission;
  checkpoint(id: string, label: string): Checkpoint;
  dispatch(id: string, ticketRef: string): DispatchRecord;
}

export class BmadLoopRunner {
  constructor(private readonly control: LoopControl) {}

  start(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (mission.loop === "draft") this.control.transitionLoop(missionId, "ready");
    return this.control.transitionLoop(missionId, "running");
  }

  resume(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (mission.loop !== "blocked" && mission.loop !== "failed") {
      throw new Error("Resume applies to a blocked or failed mission.");
    }
    return this.control.transitionLoop(missionId, "ready");
  }

  pause(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (!["running", "verifying", "reviewing", "attacking", "repairing"].includes(mission.loop)) {
      throw new Error("Pause applies to a running mission.");
    }
    return this.control.transitionLoop(missionId, "blocked");
  }

  cancel(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (mission.loop === "released") throw new Error("A released mission cannot be cancelled.");
    return this.control.transitionLoop(missionId, "cancelled");
  }

  retry(missionId: string, ticketRef: string): DispatchRecord {
    return this.control.dispatch(missionId, ticketRef);
  }

  checkpoint(missionId: string, label: string): Checkpoint {
    return this.control.checkpoint(missionId, label);
  }

  verify(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (mission.loop !== "running" && mission.loop !== "repairing") {
      throw new Error("Verify applies after running work.");
    }
    return this.control.transitionLoop(missionId, "verifying");
  }

  review(missionId: string): Mission {
    return this.control.transitionLoop(missionId, "reviewing");
  }

  commit(missionId: string): Mission {
    const mission = this.control.mission(missionId);
    if (mission.loop !== "verified") throw new Error("Commit applies only after verification.");
    return this.control.transitionLoop(missionId, "committed");
  }
}
