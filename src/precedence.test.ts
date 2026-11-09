// Guards the assumption run.ts relies on: options passed to backportRun as
// `options` lose to the repo's remote .backportrc.json, while CLI args
// (`processArgs`) win. rr_oks's .backportrc.json sets commitConflicts: true,
// so comment mode must turn it off through processArgs.
import * as github from 'backport/dist/lib/github/v4/getOptionsFromGithub/getOptionsFromGithub';
import { getOptionsFromCliArgs } from 'backport/dist/options/cliArgs';
import * as config from 'backport/dist/options/config/config';
import { getOptions } from 'backport/dist/options/options';

const remoteConfig = { commitConflicts: true } as any;

beforeEach(() => {
  jest.spyOn(github, 'getOptionsFromGithub').mockResolvedValue(remoteConfig);
});
afterEach(() => jest.restoreAllMocks());

function configFilesWith(optionsFromModule: any) {
  // stands in for reading ~/.backport/config.json and a local project config
  jest
    .spyOn(config, 'getOptionsFromConfigFiles')
    .mockResolvedValue({ ...optionsFromModule });
}

const base = {
  accessToken: 'token',
  repoOwner: 'rapyuta-robotics',
  repoName: 'rr_oks',
  pullNumber: 1,
  interactive: false,
  branchLabelMapping: { '^backport-to-(.+)$': '$1' },
};

it('module options do not override the remote repo config', async () => {
  const optionsFromModule = { ...base, commitConflicts: false };
  configFilesWith(optionsFromModule);
  const options = await getOptions({
    optionsFromCliArgs: getOptionsFromCliArgs([]),
    optionsFromModule,
  });
  expect(options.commitConflicts).toBe(true);
});

it('`--commitConflicts false` in processArgs overrides the remote repo config', async () => {
  configFilesWith(base);
  const options = await getOptions({
    optionsFromCliArgs: getOptionsFromCliArgs(['--commitConflicts', 'false']),
    optionsFromModule: base,
  });
  expect(options.commitConflicts).toBe(false);
});
