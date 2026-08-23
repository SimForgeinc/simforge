import type { ScenarioTemplateV2 } from './schema/v2/template.js';

export interface InitialRouteMigrationResult {
  readonly template: ScenarioTemplateV2;
  readonly interactionIds: readonly string[];
}

/**
 * Upgrade Studio's legacy generated `route(... lanePath)` command at t=0 into
 * canonical actor spawn state. Authored route events, including every timed
 * reroute, remain choreography. References to a legacy interaction also keep
 * it in place so migration can never create a dangling `after()` trigger.
 */
export function migrateLegacyInitialRoutes(template: ScenarioTemplateV2): InitialRouteMigrationResult {
  const referenced = new Set<string>();
  for (const interaction of template.choreography.interactions) {
    if (interaction.trigger.kind === 'after') referenced.add(interaction.trigger.of);
    if (interaction.until?.kind === 'after') referenced.add(interaction.until.of);
  }

  const migrated = new Map<string, Extract<ScenarioTemplateV2['roles'][number], { kind: 'scene_absolute' }>['initialRoute']>();
  const interactionIds: string[] = [];
  for (const role of template.roles) {
    if (role.kind !== 'scene_absolute' || role.initialRoute) continue;
    const legacy = template.choreography.interactions.find((interaction) => {
      if (interaction.actor !== role.id || interaction.verb !== 'route' || interaction.target.mode !== 'lanePath') return false;
      if (interaction.trigger.kind !== 'at' || interaction.trigger.t !== 0 || referenced.has(interaction.id)) return false;
      const generatedId = interaction.id === `route_${role.id}_initial`.slice(0, 64);
      const generatedLabel = /^(random turns|default route)$/i.test(interaction.label?.trim() ?? '');
      return generatedId || generatedLabel;
    });
    if (!legacy || legacy.verb !== 'route' || legacy.target.mode !== 'lanePath') continue;
    migrated.set(role.id, { mode: 'lanePath', lanes: [...legacy.target.lanes] });
    interactionIds.push(legacy.id);
  }
  if (interactionIds.length === 0) return { template, interactionIds };

  const removed = new Set(interactionIds);
  return {
    template: {
      ...template,
      roles: template.roles.map((role) => role.kind === 'scene_absolute' && migrated.has(role.id)
        ? { ...role, initialRoute: migrated.get(role.id)! }
        : role),
      choreography: {
        ...template.choreography,
        interactions: template.choreography.interactions.filter((interaction) => !removed.has(interaction.id)),
      },
    },
    interactionIds,
  };
}
