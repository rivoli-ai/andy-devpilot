jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    run: jest.fn(),
  },
}));

import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';

setupZoneTestEnv();
