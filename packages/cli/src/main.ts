#!/usr/bin/env node
import fs from "node:fs";
import { BmadControlPlane } from "@bmad-next/control-plane";
import type { Mission } from "@bmad-next/control-plane";

const root = process.cwd();
const plane = new BmadControlPlane(root);
const [command, ...rest] = process.argv.slice(2);

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function summary(mission: Mission): unknown {
  return {
    id: mission.id,
    title: mission.title,
    complexity: mission.complexity,
    mode: mission.mode,
    phase: mission.phase,
    loop: mission.loop,
    forge: mission.forge
      ? {
          outcome: mission.forge.outcome,
          open: mission.forge.questions.filter((question) => !mission.forge?.answered.includes(question.id)),
        }
      : null,
    requirements: mission.requirements.map((requirement) => ({ id: requirement.id, status: requirement.status, version: requirement.version })),
    tickets: mission.tickets.map((ticket) => ticket.ref),
    workflow: mission.workflow.map((step) => ({ skill: step.skillId, status: step.status })),
  };
}

function help(): void {
  print(`BMAD Next

bmad-next doctor
bmad-next mission create|list|show|resume|pause|cancel
bmad-next next
bmad-next forge answer|harden|kill
bmad-next spec|prd|architecture|stories
bmad-next build <ticket>
bmad-next repair <ticket>
bmad-next verify|review [ticket]|attack|security|browser|nfr
bmad-next release [mission-id]
bmad-next release approve <mission-id> --by "Name"
bmad-next release reject <mission-id> --by "Name"
bmad-next release verify <mission-id>
bmad-next evidence list
bmad-next requirements
bmad-next tickets
bmad-next tickets accept <name>
bmad-next agents
bmad-next memory [query]
bmad-next export [mission-id]
bmad-next import <file>
bmad-next timeline [mission-id]
bmad-next plugin list|install <manifest.json>|enable <id>|disable <id>|remove <id>
bmad-next index
bmad-next services
bmad-next scan deep
bmad-next intent "@bmad what should I do next?"

Release PASS is recorded only when required evidence artifacts exist.`);
}

function missionId(): string {
  return plane.mission().id;
}

void (async () => {
  switch (command) {
    case undefined:
    case "help":
      help();
      break;
    case "doctor":
      print(plane.doctor());
      break;
    case "mission":
      if (rest[0] === "create") print(summary(plane.createMission(rest.slice(1).join(" "))));
      else if (rest[0] === "list") print(plane.listMissions());
      else if (rest[0] === "show") print(summary(plane.mission(rest[1])));
      else if (rest[0] === "resume") print(summary(plane.resumeMission(rest[1] ?? missionId())));
      else if (rest[0] === "pause") print(summary(plane.pauseMission(rest[1] ?? missionId())));
      else if (rest[0] === "cancel") print(summary(plane.cancelMission(rest[1] ?? missionId())));
      else print(summary(plane.mission()));
      break;
    case "status":
      print(summary(plane.mission()));
      break;
    case "next":
      print(plane.recommend());
      break;
    case "spec":
      print(summary(plane.runSkill(missionId(), "bmad-spec")));
      break;
    case "prd":
      print(summary(plane.runSkill(missionId(), "bmad-prd")));
      break;
    case "architecture":
      print(summary(plane.runSkill(missionId(), "bmad-architecture")));
      break;
    case "stories":
      print(summary(plane.stories(missionId())));
      break;
    case "verify":
      if (rest[0]?.startsWith("REQ-")) print(await plane.verifyRequirement(missionId(), rest[0]));
      else if (rest[0]) print(plane.verifyTicket(missionId(), rest[0]));
      else print(summary(plane.verifyMission(missionId())));
      break;
    case "review":
      if (rest[0]) print(plane.reviewTicket(missionId(), rest[0]));
      else print(summary(plane.reviewMission(missionId())));
      break;
    case "repair":
      print(plane.repairTicket(missionId(), rest[0] ?? ""));
      break;
    case "attack":
      print(plane.attackTicket(missionId(), rest[0]));
      break;
    case "browser":
      print(await plane.runBrowser(missionId(), rest[0]));
      break;
    case "security":
      print(plane.runSecurity(missionId(), rest[0]));
      break;
    case "nfr":
      print(plane.measureNfr(missionId(), rest[0]));
      break;
    case "evidence":
      print(plane.mission().evidence);
      break;
    case "requirements":
      print(plane.mission().requirements);
      break;
    case "agents":
      print(plane.agentAvailability());
      break;
    case "memory":
      print(plane.searchMemory(missionId(), rest.join(" ")));
      break;
    case "forge":
      if (rest[0] === "harden") print(summary(plane.answerForge(plane.mission().id, "harden")));
      else if (rest[0] === "kill") print(summary(plane.answerForge(plane.mission().id, `kill ${rest.slice(1).join(" ")}`)));
      else if (rest[0] === "answer") print(summary(plane.answerForge(plane.mission().id, rest.slice(1).join(" "))));
      else throw new Error("Use forge answer, forge harden, or forge kill.");
      break;
    case "tickets":
      if (rest[0] === "accept") print(summary(plane.acceptTicketTree(missionId(), rest[1] ?? "")));
      else {
        print(plane.mission().tickets.map((ticket) => {
          const plan = plane.mission().plans.find((item) => item.ref === ticket.ref);
          return { ref: ticket.ref, title: ticket.title, priority: ticket.priority, risk: ticket.risk, plan: plan?.status ?? "planned", plan_file: ticket.plan_file };
        }));
      }
      break;
    case "build":
      print(plane.executeTicket(missionId(), rest[0] ?? ""));
      break;
    case "release": {
      const sub = rest[0];
      const byFlag = rest.indexOf("--by");
      const by = byFlag >= 0 ? rest.slice(byFlag + 1).join(" ").replace(/^"|"$/g, "") : "";
      if (sub === "approve" || sub === "reject") {
        const missionId = rest[1];
        if (!missionId || missionId.startsWith("--") || !by.trim()) {
          throw new Error('Usage: bmad-next release approve <mission-id> --by "Name"');
        }
        const reason = sub === "approve" ? "CLI release approval." : "CLI release rejection.";
        print(sub === "approve" ? plane.approve(missionId, "release", by, reason) : plane.rejectRelease(missionId, by, reason));
        break;
      }
      if (sub === "verify") {
        print(plane.verifyRelease(rest[1] && !rest[1].startsWith("--") ? rest[1] : plane.mission().id));
        break;
      }
      print(plane.releaseGate(sub && !sub.startsWith("--") ? sub : plane.mission().id));
      break;
    }
    case "export":
      print(plane.exportMission(rest[0] ?? missionId()));
      break;
    case "import":
      print(summary(plane.importMission(fs.readFileSync(rest[0] ?? "", "utf8"))));
      break;
    case "timeline":
      print(plane.timeline(rest[0] ?? missionId()));
      break;
    case "plugin":
      if (rest[0] === "list") print(plane.plugins());
      else if (rest[0] === "install") print(plane.addPlugin(JSON.parse(fs.readFileSync(rest[1] ?? "", "utf8"))));
      else if (rest[0] === "enable" || rest[0] === "disable") print(plane.enablePlugin(rest[1] ?? "", rest[0] === "enable"));
      else if (rest[0] === "remove") print(plane.deletePlugin(rest[1] ?? ""));
      else throw new Error("Use plugin list, install, enable, disable, or remove.");
      break;
    case "index":
      print(plane.fileIndex());
      break;
    case "services":
      print(plane.services());
      break;
    case "scan":
      print(plane.scan(rest[0] === "exhaustive" || rest[0] === "deep" || rest[0] === "quick" ? rest[0] : "quick"));
      break;
    case "intent": {
      const intent = plane.handleIntent(rest.join(" "));
      print({ ...intent, detail: await intent.detail });
      break;
    }
    default:
      throw new Error(`Unknown command ${command}. Run bmad-next help.`);
  }
})().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
