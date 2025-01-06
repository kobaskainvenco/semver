import {
  Options as CommitParserOptions,
  sync as parseConventionalCommitsSync,
} from 'conventional-commits-parser';
import * as conventionalRecommendedBump from 'conventional-recommended-bump';
import { defer, forkJoin, iif, of, type Observable } from 'rxjs';
import {
  catchError,
  defaultIfEmpty,
  map,
  shareReplay,
  switchMap,
} from 'rxjs/operators';
import * as semver from 'semver';
import type { PresetOpt, ReleaseIdentifier } from '../schema';
import { type Version } from '../version';
import { getLastVersion } from './get-last-version';
import { type DependencyRoot } from './get-project-dependencies';
import { getCommits, getFirstCommitRef } from './git';
import { _logStep } from './logger';
import { formatTag, formatTagPrefix } from './tag';

export interface NewVersion {
  version: string;
  previousVersion: string;
  dependencyUpdates: Version[];
}

const initialVersion = '0.0.0';

export function getProjectVersion({
  tagPrefix,
  projectRoot,
  releaseType,
  since,
  projectName,
  preid,
}: {
  tagPrefix: string;
  projectRoot: string;
  releaseType?: ReleaseIdentifier;
  since?: string;
  projectName: string;
  preid?: string;
}) {
  const lastVersion$ = getLastVersion({
    tagPrefix,
    preid,
    releaseType,
  }).pipe(
    catchError(() => {
      _logStep({
        step: 'warning',
        level: 'warn',
        message: `No previous version tag found, fallback to version 0.0.0.
        New version will be calculated based on all changes since first commit.
        If your project is already versioned, please tag the latest release commit with ${tagPrefix}x.y.z and run this command again.`,
        projectName,
      });
      return of(initialVersion);
    }),
    shareReplay({
      refCount: true,
      bufferSize: 1,
    }),
  );

  const lastVersionGitRef$ = lastVersion$.pipe(
    /** If lastVersion equals 0.0.0 it means no tag exist,
     * then get the first commit ref to compute the initial version. */
    switchMap((lastVersion) =>
      iif(
        () => _isInitialVersion({ lastVersion }),
        getFirstCommitRef(),
        of(formatTag({ tagPrefix, version: lastVersion })),
      ),
    ),
  );

  const commits$ = lastVersionGitRef$.pipe(
    switchMap((lastVersionGitRef) => {
      return getCommits({
        projectRoot,
        since: since ?? lastVersionGitRef,
      });
    }),
  );

  return {
    lastVersion$,
    commits$,
    lastVersionGitRef$,
  };
}

/**
 * Return new version or null if nothing changed.
 */
export function tryBump({
  commitParserOptions,
  preset,
  projectRoot,
  tagPrefix,
  dependencyRoots = [],
  releaseType,
  preid,
  skipUnstable,
  versionTagPrefix,
  syncVersions,
  allowEmptyRelease,
  skipCommitTypes,
  projectName,
}: {
  commitParserOptions?: CommitParserOptions;
  preset: PresetOpt;
  projectRoot: string;
  tagPrefix: string;
  dependencyRoots?: DependencyRoot[];
  releaseType?: ReleaseIdentifier;
  preid?: string;
  skipUnstable?: boolean;
  versionTagPrefix?: string | null;
  syncVersions: boolean;
  allowEmptyRelease?: boolean;
  skipCommitTypes: string[];
  projectName: string;
}): Observable<NewVersion | null> {
  const { lastVersion$, commits$, lastVersionGitRef$ } = getProjectVersion({
    tagPrefix,
    projectRoot,
    releaseType,
    projectName,
    preid,
  });

  return forkJoin([lastVersion$, commits$, lastVersionGitRef$]).pipe(
    switchMap(([lastVersion, commits, lastVersionGitRef]) => {
      if (releaseType && releaseType !== 'prerelease') {
        return _manualBump({
          since: lastVersion,
          releaseType,
          preid,
        }).pipe(
          map((version) =>
            version
              ? ({
                  version,
                  previousVersion: lastVersion,
                  dependencyUpdates: [],
                } satisfies NewVersion)
              : null,
          ),
        );
      }

      const projectBump$ = _semverBump({
        since: lastVersion,
        preset,
        projectRoot,
        tagPrefix,
        releaseType,
        preid,
        skipUnstable,
      }).pipe(map((version) => ({ type: 'project', version })));

      const dependencyVersions$ = _getDependencyVersions({
        commitParserOptions,
        lastVersionGitRef,
        dependencyRoots,
        preset,
        releaseType,
        versionTagPrefix,
        skipCommitTypes,
        syncVersions,
        projectName,
        preid,
      });

      return forkJoin([projectBump$, dependencyVersions$]).pipe(
        switchMap(([projectVersion, dependencyVersions]) => {
          const dependencyUpdates = dependencyVersions.filter(_isNewVersion);
          const newVersion: NewVersion = {
            version: projectVersion.version || lastVersion,
            previousVersion: lastVersion,
            dependencyUpdates,
          };

          /* bump patch version if dependency updates are available */
          if (projectVersion.version === null && dependencyUpdates.length) {
            return _manualBump({
              since: lastVersion,
              releaseType: 'patch',
              preid: preid as string,
            }).pipe(
              map((version) =>
                version
                  ? ({
                      ...newVersion,
                      version: version || lastVersion,
                      previousVersion: lastVersion,
                    } satisfies NewVersion)
                  : null,
              ),
            );
          }

          const filteredCommits = commits.filter((commit: string) =>
            shouldCommitBeCalculated({
              commit,
              commitParserOptions,
              skipCommitTypes,
            }),
          );

          /* No commits since last release & no dependency updates so don't bump if the `releastAtLeast` flag is not present. */
          if (
            !dependencyUpdates.length &&
            !filteredCommits.length &&
            !allowEmptyRelease
          ) {
            return of(null);
          }

          return of(newVersion);
        }),
      );
    }),
  );
}

/* istanbul ignore next */
export function _semverBump({
  since,
  preset,
  projectRoot,
  tagPrefix,
  releaseType,
  preid,
  skipUnstable,
}: {
  since: string;
  preset: PresetOpt;
  projectRoot: string;
  tagPrefix: string;
  releaseType?: ReleaseIdentifier;
  preid?: string;
  skipUnstable?: boolean;
}) {
  return defer(async () => {
    const recommended = await conventionalRecommendedBump({
      path: projectRoot,
      tagPrefix,
      skipUnstable: skipUnstable ?? false,
      ...(typeof preset === 'string'
        ? { preset }
        : { preset: preset.name ?? 'conventionalcommits', config: preset }),
    });

    let recommendedReleaseType: ReleaseIdentifier | undefined =
      recommended.releaseType;
    if (recommendedReleaseType && releaseType === 'prerelease') {
      recommendedReleaseType =
        semver.parse(since)?.prerelease.length === 0
          ? `pre${recommendedReleaseType}`
          : releaseType;
    }

    return recommendedReleaseType
      ? semver.inc(since, recommendedReleaseType, preid)
      : null;
  });
}

/* istanbul ignore next */
export function _manualBump({
  since,
  releaseType,
  preid,
}: {
  since: string;
  releaseType: string;
  preid?: string;
}) {
  return defer(() => {
    const semverArgs: [string, ReleaseIdentifier, ...string[]] = [
      since,
      releaseType as ReleaseIdentifier,
      ...(preid ? [preid] : []),
    ];

    return of(semver.inc(...semverArgs));
  });
}

function shouldCommitBeCalculated({
  commit,
  commitParserOptions,
  skipCommitTypes,
}: {
  commit: string;
  commitParserOptions?: CommitParserOptions;
  skipCommitTypes: string[];
}): boolean {
  const { type } = parseConventionalCommitsSync(
    commit,
    commitParserOptions ?? {},
  );
  const shouldSkip = skipCommitTypes.some((typeToSkip) => typeToSkip === type);
  return !shouldSkip;
}

export function _getDependencyVersions({
  commitParserOptions,
  preset,
  dependencyRoots,
  releaseType,
  versionTagPrefix,
  syncVersions,
  lastVersionGitRef,
  skipCommitTypes,
  projectName,
  preid,
  skipUnstable,
}: {
  commitParserOptions?: CommitParserOptions;
  preset: PresetOpt;
  lastVersionGitRef: string;
  dependencyRoots: DependencyRoot[];
  releaseType?: ReleaseIdentifier;
  skipCommitTypes: string[];
  versionTagPrefix?: string | null;
  syncVersions: boolean;
  projectName: string;
  preid?: string;
  skipUnstable?: boolean;
}): Observable<Version[]> {
  return forkJoin(
    dependencyRoots.map(({ path: projectRoot, name: dependencyName }) => {
      /* Get dependency version changes since last project version */
      const tagPrefix = formatTagPrefix({
        versionTagPrefix,
        projectName: dependencyName,
        syncVersions,
      });

      const { lastVersion$, commits$ } = getProjectVersion({
        tagPrefix,
        projectRoot,
        releaseType,
        since: lastVersionGitRef,
        projectName,
        preid,
      });

      return forkJoin([lastVersion$, commits$]).pipe(
        switchMap(([dependencyLastVersion, commits]) => {
          const filteredCommits = commits.filter((commit) =>
            shouldCommitBeCalculated({
              commit,
              commitParserOptions,
              skipCommitTypes,
            }),
          );
          if (filteredCommits.length === 0) {
            return of({
              type: 'dependency',
              version: null,
              dependencyName: dependencyName,
            } satisfies Version);
          }

          /* Dependency has changes but has no tagged version */
          if (_isInitialVersion({ lastVersion: dependencyLastVersion })) {
            return _semverBump({
              since: dependencyLastVersion,
              preset,
              projectRoot,
              tagPrefix,
              skipUnstable,
            }).pipe(
              map(
                (version) =>
                  ({
                    type: 'dependency',
                    version,
                    dependencyName: dependencyName,
                  }) satisfies Version,
              ),
            );
          }

          /* Return the changed version of dependency since last commit within project */
          return of({
            type: 'dependency',
            version: dependencyLastVersion,
            dependencyName: dependencyName,
          } satisfies Version);
        }),
      );
    }),
  ).pipe(defaultIfEmpty([]));
}

export function _isNewVersion(version: Version): boolean {
  return version.version !== null && version.version !== initialVersion;
}

export function _isInitialVersion({
  lastVersion,
}: {
  lastVersion: string;
}): boolean {
  return lastVersion === initialVersion;
}
