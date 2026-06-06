import { stringify } from "yaml";
import type { DAGPlan } from "../orchestrator/planner";

export class MintEmitter {
    /**
     * Compile a b4mal DAGPlan directly into an RWX mint.yml pipeline.
     */
    static emit(dag: DAGPlan): string {
        const mintTasks = Array.from(dag.tasks.values()).map(task => {
            // Reconstruct the command string
            let runStr = task.cmd.join(" ");
            
            // Basic unwrapping if it was wrapped in sh -c
            if (task.cmd[0] === "sh" && task.cmd[1] === "-c" && task.cmd.length === 3) {
                runStr = task.cmd[2];
            }

            const mintTask: any = {
                key: task.id,
                run: runStr,
            };

            if (task.deps && task.deps.length > 0) {
                mintTask.after = task.deps;
            }

            return mintTask;
        });

        const pipeline = {
            version: "1.0",
            tasks: mintTasks,
        };

        return stringify(pipeline);
    }
}
