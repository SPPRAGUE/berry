/// <reference path="./tauProlog.d.ts"/>
import {Ident, MessageName, nodeUtils, Project, ReportError, Workspace} from '@yarnpkg/core';
import {miscUtils, structUtils}                                         from '@yarnpkg/core';
import {xfs, ppath, PortablePath}                                       from '@yarnpkg/fslib';
// @ts-expect-error - reason TBS
import plLists                                                          from 'tau-prolog/modules/lists';
import pl                                                               from 'tau-prolog';

import * as constraintUtils                                             from './constraintUtils';
import {linkProjectToSession}                                           from './tauModule';

plLists(pl);

export type EnforcedDependency = {
  workspace: Workspace;
  dependencyIdent: Ident;
  dependencyRange: string | null;
  dependencyType: DependencyType;
};

export type EnforcedField = {
  workspace: Workspace;
  fieldPath: string;
  fieldValue: string | null;
};

export enum DependencyType {
  Dependencies = `dependencies`,
  DevDependencies = `devDependencies`,
  PeerDependencies = `peerDependencies`,
}

const DEPENDENCY_TYPES = [
  DependencyType.Dependencies,
  DependencyType.DevDependencies,
  DependencyType.PeerDependencies,
];

function extractErrorImpl(value: any): any {
  if (value instanceof pl.type.Num)
    return value.value;

  if (value instanceof pl.type.Term) {
    switch (value.indicator) {
      case `throw/1`:
        return extractErrorImpl(value.args[0]);
      case `error/1`:
        return extractErrorImpl(value.args[0]);
      case `error/2`:
        if (value.args[0] instanceof pl.type.Term && value.args[0].indicator === `syntax_error/1`) {
          return Object.assign(extractErrorImpl(value.args[0]), ...extractErrorImpl(value.args[1]));
        } else {
          const err = extractErrorImpl(value.args[0]);
          err.message += ` (in ${extractErrorImpl(value.args[1])})`;
          return err;
        }
      case `syntax_error/1`:
        return new ReportError(MessageName.PROLOG_SYNTAX_ERROR, `Syntax error: ${extractErrorImpl(value.args[0])}`);
      case `existence_error/2`:
        return new ReportError(MessageName.PROLOG_EXISTENCE_ERROR, `Existence error: ${extractErrorImpl(value.args[0])} ${extractErrorImpl(value.args[1])} not found`);
      case `instantiation_error/0`:
        return new ReportError(MessageName.PROLOG_INSTANTIATION_ERROR, `Instantiation error: an argument is variable when an instantiated argument was expected`);
      case `line/1`:
        return {line: extractErrorImpl(value.args[0])};
      case `column/1`:
        return {column: extractErrorImpl(value.args[0])};
      case `found/1`:
        return {found: extractErrorImpl(value.args[0])};
      case `./2`:
        return [extractErrorImpl(value.args[0])].concat(extractErrorImpl(value.args[1]));
      case `//2`:
        return `${extractErrorImpl(value.args[0])}/${extractErrorImpl(value.args[1])}`;
      default:
        return value.id;
    }
  }

  throw `couldn't pretty print because of unsupported node ${value}`;
}

function extractError(val: any) {
  let err;
  try {
    err = extractErrorImpl(val);
  } catch (caught) {
    if (typeof caught === `string`) {
      throw new ReportError(MessageName.PROLOG_UNKNOWN_ERROR, `Unknown error: ${val} (note: ${caught})`);
    } else {
      throw caught;
    }
  }

  if (typeof err.line !== `undefined` && typeof err.column !== `undefined`)
    err.message += ` at line ${err.line}, column ${err.column}`;

  return err;
}

class Session {
  private readonly session: pl.type.Session;

  public constructor(project: Project, source: string) {
    // The default Tau Prolog resolution steps limit is quite small
    // By using a proportional limit (instead of no limit), we avoid triggering pathological cases "easily"
    // See https://github.com/yarnpkg/berry/issues/1260
    const limit = 1000 * project.workspaces.length;
    this.session = pl.create(limit);
    linkProjectToSession(this.session, project);

    this.session.consult(`:- use_module(library(lists)).`);
    this.session.consult(source);
  }

  private fetchNextAnswer() {
    return new Promise<pl.Answer>(resolve => {
      this.session.answer((result: any) => {
        resolve(result);
      });
    });
  }

  public async * makeQuery(query: string) {
    const parsed = this.session.query(query);

    if (parsed !== true)
      throw extractError(parsed);

    while (true) {
      const answer = await this.fetchNextAnswer();

      if (answer === null)
        throw new ReportError(MessageName.PROLOG_LIMIT_EXCEEDED, `Resolution limit exceeded`);

      if (!answer)
        break;

      if (answer.id === `throw`)
        throw extractError(answer);

      yield answer;
    }
  }
}

function parseLink(link: pl.Link): string | null {
  if (link.id === `null`) {
    return null;
  } else {
    return `${link.toJavaScript()}`;
  }
}

function parseLinkToJson(link: pl.Link): string | null {
  if (link.id === `null`) {
    return null;
  } else {
    const val = link.toJavaScript();
    if (typeof val !== `string`)
      return JSON.stringify(val);

    try {
      return JSON.stringify(JSON.parse(val));
    } catch {
      return JSON.stringify(val);
    }
  }
}

export class Constraints implements constraintUtils.Engine {
  public readonly project: Project;

  public readonly source: string = ``;

  static async find(project: Project) {
    return new Constraints(project);
  }

  constructor(project: Project) {
    this.project = project;

    const constraintsPath = project.configuration.get(`constraintsPath`);

    if (xfs.existsSync(constraintsPath)) {
      this.source = xfs.readFileSync(constraintsPath, `utf8`);
    }
  }

  getProjectDatabase() {
    let database = ``;

    for (const dependencyType of DEPENDENCY_TYPES)
      database += `dependency_type(${dependencyType}).\n`;

    for (const workspace of this.project.workspacesByCwd.values()) {
      const relativeCwd = workspace.relativeCwd;

      database += `workspace(${escape(relativeCwd)}).\n`;
      database += `workspace_ident(${escape(relativeCwd)}, ${escape(structUtils.stringifyIdent(workspace.anchoredLocator))}).\n`;
      database += `workspace_version(${escape(relativeCwd)}, ${escape(workspace.manifest.version)}).\n`;

      for (const dependencyType of DEPENDENCY_TYPES) {
        for (const dependency of workspace.manifest[dependencyType].values()) {
          database += `workspace_has_dependency(${escape(relativeCwd)}, ${escape(structUtils.stringifyIdent(dependency))}, ${escape(dependency.range)}, ${dependencyType}).\n`;
        }
      }
    }

    // Add default never matching predicates to prevent prolog instantiation errors
    // when constraints run in an empty workspace
    database += `workspace(_) :- false.\n`;
    database += `workspace_ident(_, _) :- false.\n`;
    database += `workspace_version(_, _) :- false.\n`;

    // Add a default never matching predicate to prevent prolog instantiation errors
    // when constraints run in a workspace without dependencies
    database += `workspace_has_dependency(_, _, _, _) :- false.\n`;

    return database;
  }

  getDeclarations() {
    let declarations = ``;

    // (Cwd, DependencyIdent, DependencyRange, DependencyType)
    declarations += `gen_enforced_dependency(_, _, _, _) :- false.\n`;

    // (Cwd, Path, Value)
    declarations += `gen_enforced_field(_, _, _) :- false.\n`;

    return declarations;
  }

  get fullSource() {
    return `${this.getProjectDatabase()}\n${this.source}\n${this.getDeclarations()}`;
  }

  private createSession() {
    return new Session(this.project, this.fullSource);
  }

  async processClassic() {
    const session = this.createSession();

    return {
      enforcedDependencies: await this.genEnforcedDependencies(session),
      enforcedFields: await this.genEnforcedFields(session),
    };
  }

  async process(): Promise<constraintUtils.ProcessResult> {
    const {
      enforcedDependencies,
      enforcedFields,
    } = await this.processClassic();

    const manifestUpdates = new Map<PortablePath, Map<string, Map<any, Set<nodeUtils.Caller>>>>();

    for (const {workspace, dependencyIdent, dependencyRange, dependencyType} of enforcedDependencies) {
      const normalizedPath = constraintUtils.normalizePath([dependencyType, structUtils.stringifyIdent(dependencyIdent)]);

      const workspaceUpdates = miscUtils.getMapWithDefault(manifestUpdates, workspace.cwd);
      const pathUpdates = miscUtils.getMapWithDefault(workspaceUpdates, normalizedPath);

      pathUpdates.set(dependencyRange ?? undefined, new Set());
    }

    for (const {workspace, fieldPath, fieldValue} of enforcedFields) {
      const normalizedPath = constraintUtils.normalizePath(fieldPath);

      const workspaceUpdates = miscUtils.getMapWithDefault(manifestUpdates, workspace.cwd);
      const pathUpdates = miscUtils.getMapWithDefault(workspaceUpdates, normalizedPath);

      pathUpdates.set(JSON.parse(fieldValue as string) ?? undefined, new Set());
    }

    return {
      manifestUpdates,
      reportedErrors: new Map(),
    };
  }

  private async genEnforcedDependencies(session: Session) {
    const enforcedDependencies: Array<EnforcedDependency> = [];

    for await (const answer of session.makeQuery(`workspace(WorkspaceCwd), dependency_type(DependencyType), gen_enforced_dependency(WorkspaceCwd, DependencyIdent, DependencyRange, DependencyType).`)) {
      const workspaceCwd = ppath.resolve(this.project.cwd, parseLink(answer.links.WorkspaceCwd) as PortablePath);
      const dependencyRawIdent = parseLink(answer.links.DependencyIdent);
      const dependencyRange = parseLink(answer.links.DependencyRange);
      const dependencyType = parseLink(answer.links.DependencyType) as DependencyType;

      if (workspaceCwd === null || dependencyRawIdent === null)
        throw new Error(`Invalid rule`);

      const workspace = this.project.getWorkspaceByCwd(workspaceCwd);
      const dependencyIdent = structUtils.parseIdent(dependencyRawIdent);

      enforcedDependencies.push({workspace, dependencyIdent, dependencyRange, dependencyType});
    }

    return miscUtils.sortMap(enforcedDependencies, [
      ({dependencyRange}) => dependencyRange !== null ? `0` : `1`,
      ({workspace}) => structUtils.stringifyIdent(workspace.anchoredLocator),
      ({dependencyIdent}) => structUtils.stringifyIdent(dependencyIdent),
    ]);
  }

  private async genEnforcedFields(session: Session) {
    const enforcedFields: Array<EnforcedField> = [];

    for await (const answer of session.makeQuery(`workspace(WorkspaceCwd), gen_enforced_field(WorkspaceCwd, FieldPath, FieldValue).`)) {
      const workspaceCwd = ppath.resolve(this.project.cwd, parseLink(answer.links.WorkspaceCwd) as PortablePath);
      const fieldPath = parseLink(answer.links.FieldPath);
      const fieldValue = parseLinkToJson(answer.links.FieldValue);

      if (workspaceCwd === null || fieldPath === null)
        throw new Error(`Invalid rule`);

      const workspace = this.project.getWorkspaceByCwd(workspaceCwd);

      enforcedFields.push({workspace, fieldPath, fieldValue});
    }

    return miscUtils.sortMap(enforcedFields, [
      ({workspace}) => structUtils.stringifyIdent(workspace.anchoredLocator),
      ({fieldPath}) => fieldPath,
    ]);
  }

  async * query(query: string) {
    const session = this.createSession();

    for await (const answer of session.makeQuery(query)) {
      const parsedLinks: Record<string, string | null> = {};

      for (const [variable, value] of Object.entries(answer.links)) {
        if (variable !== `_`) {
          parsedLinks[variable] = parseLink(value);
        }
      }

      yield parsedLinks;
    }
  }
}

function escape(what: string | null) {
  if (typeof what === `string`) {
    return `'${what}'`;
  } else {
    return `[]`;
  }
}
