/**
 * Test-only omp extension: `/catalogue-probe <doc page>` reads the catalogue from the running omp
 * and prints it as one JSON line. Loaded by `test/catalogue.test.ts` with `-e`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readOmpCatalogue } from "../../src/catalogue";

export default function catalogueProbe(pi: ExtensionAPI): void {
	pi.registerCommand("catalogue-probe", {
		description: "Spellbook test probe: print the omp catalogue as JSON",
		handler: async args => {
			const catalogue = await readOmpCatalogue(pi);
			const pages = await catalogue.readDocs([args.trim()]);
			const probe = {
				skills: catalogue.skills,
				commands: catalogue.commands,
				keywords: catalogue.keywords,
				docs: catalogue.docs,
				pages,
				render: catalogue.render(),
			};
			process.stdout.write(`${JSON.stringify(probe)}\n`);
		},
	});
}
