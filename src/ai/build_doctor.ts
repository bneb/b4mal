export interface Diagnosis {
    taskId: string;
    relevantFiles: string[];
    prompt: string;
}

export class BuildDoctor {
    /**
     * Extracts potential files and line numbers from stderr,
     * formatting them into a standard prompt for AI models.
     */
    static diagnoseFailure(taskId: string, stderr: string): Diagnosis {
        const relevantFiles: string[] = [];
        
        // Match common compiler/runner output: `file.ts(1,10): error` or `at Object.<anonymous> (file.js:10:5)`
        const fileRegex = /([a-zA-Z0-9_/\-.]+\.(ts|js|jsx|tsx|rs|go|py|c|cpp))[:(]/g;
        let match;
        while ((match = fileRegex.exec(stderr)) !== null) {
            if (!relevantFiles.includes(match[1])) {
                relevantFiles.push(match[1]);
            }
        }

        const truncatedStderr = stderr.length > 4000 ? "... [TRUNCATED] ...\n" + stderr.slice(-4000) : stderr;

        const prompt = `Task '${taskId}' failed with the following error output:\n\n\`\`\`\n${truncatedStderr}\n\`\`\`\n\n` +
            (relevantFiles.length > 0 
                ? `The error appears to originate from these files: ${relevantFiles.join(", ")}.`
                : `No specific file paths could be extracted from the error.`);

        return {
            taskId,
            relevantFiles,
            prompt
        };
    }

    /**
     * Combines the diagnosis prompt with AST diffs or raw file contents
     * to formulate a targeted auto-fix prompt for an LLM.
     */
    static generateAutoFixPrompt(diagnosis: Diagnosis, fileContext: string): string {
        return `${diagnosis.prompt}\n\nHere is the relevant code context:\n\n\`\`\`\n${fileContext}\n\`\`\`\n\nPlease provide a patch or the updated file contents to resolve the error.`;
    }
}
