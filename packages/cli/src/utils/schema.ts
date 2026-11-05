import type { Command } from "commander";

export interface CommandDescription {
  name: string;
  aliases: string[];
  description: string;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{ flags: string; description: string; takesValue: boolean; default?: unknown }>;
}

/** Describes the CLI surface from commander's definitions, so it can never drift. */
export function describeCommands(program: Command): CommandDescription[] {
  const visible = (program.commands as Command[]).filter(
    (c) => !(c as unknown as { _hidden?: boolean })._hidden,
  );
  return visible.map((command) => ({
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    arguments: command.registeredArguments.map((arg) => ({
      name: arg.name(),
      required: arg.required,
      variadic: arg.variadic,
      description: arg.description,
    })),
    options: command.options.map((option) => ({
      flags: option.flags,
      description: option.description,
      takesValue: option.required || option.optional,
      ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
    })),
  }));
}
