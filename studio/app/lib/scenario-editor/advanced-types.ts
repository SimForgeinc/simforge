export type AdvancedTabId =
  | 'layers'
  | 'connection'
  | 'logs'
  | 'templates'
  | 'config'
  | 'json'
  | 'import'
  | 'shortcuts'
  | 'account';

export const ADVANCED_TABS: { id: AdvancedTabId; label: string }[] = [
  { id: 'layers', label: 'Layers' },
  { id: 'connection', label: 'Connection' },
  { id: 'logs', label: 'Logs' },
  { id: 'templates', label: 'Templates' },
  { id: 'config', label: 'Sim Config' },
  { id: 'json', label: 'JSON' },
  { id: 'import', label: 'Import' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'account', label: 'Account' },
];
