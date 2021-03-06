import { API, GraphQLResult, GRAPHQL_AUTH_MODE } from "@aws-amplify/api";
import {
  CreateParams,
  CreateResult,
  DeleteManyParams,
  DeleteManyResult,
  DeleteParams,
  DeleteResult,
  GetListParams,
  GetListResult,
  GetManyParams,
  GetManyReferenceParams,
  GetManyReferenceResult,
  GetManyResult,
  GetOneParams,
  GetOneResult,
  UpdateManyParams,
  UpdateManyResult,
  UpdateParams,
  UpdateResult,
} from "ra-core";
import { Filter } from "./Filter";
import { Pagination } from "./Pagination";

export interface Operations {
  queries: Record<string, string>;
  mutations: Record<string, string>;
}

export interface DataProviderOptions {
  authMode?: GRAPHQL_AUTH_MODE;
}

const defaultOptions: DataProviderOptions = {
  authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
};

export class DataProvider {
  public queries: Record<string, string>;
  public mutations: Record<string, string>;
  public authMode: GRAPHQL_AUTH_MODE;

  public constructor(
    operations: Operations,
    options: DataProviderOptions = defaultOptions
  ) {
    const optionsBag = { ...defaultOptions, ...options };

    this.queries = operations.queries;
    this.mutations = operations.mutations;
    this.authMode = <GRAPHQL_AUTH_MODE>optionsBag.authMode;
  }

  public getList = async (
    resource: string,
    params: GetListParams
  ): Promise<GetListResult> => {
    const { filter } = params;

    let queryName = Filter.getQueryName(this.queries, filter);
    let queryVariables = Filter.getQueryVariables(filter);

    if (!queryName || !queryVariables) {
      // Default list query without filter
      queryName = `list${resource.charAt(0).toUpperCase() + resource.slice(1)}`;
    }

    const query = this.getQuery(queryName);

    if (!queryVariables) {
      queryVariables = {};
    }

    const { page, perPage } = params.pagination;

    // Defines a unique identifier of the query
    const querySignature = JSON.stringify({
      queryName,
      queryVariables,
      perPage,
    });

    const nextToken = Pagination.getNextToken(querySignature, page);

    // Checks if page requested is out of range
    if (typeof nextToken === "undefined") {
      return {
        data: [],
        total: 0,
      }; // React admin will redirect to page 1
    }

    // Adds sorting if requested
    if (params.sort.field === queryName) {
      queryVariables["sortDirection"] = params.sort.order;
    }

    // Executes the query
    const queryData = (
      await this.graphql(query, {
        ...queryVariables,
        limit: perPage,
        nextToken,
      })
    )[queryName];

    // Saves next token
    Pagination.saveNextToken(queryData.nextToken, querySignature, page);

    // Computes total
    let total = (page - 1) * perPage + queryData.items.length;
    if (queryData.nextToken) {
      total++; // Tells react admin that there is at least one more page
    }

    return {
      data: queryData.items,
      total,
    };
  };

  public getOne = async (
    resource: string,
    params: GetOneParams
  ): Promise<GetOneResult> => {
    const queryName = `get${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    // Executes the query
    const queryData = (await this.graphql(query, { id: params.id }))[queryName];

    return {
      data: queryData,
    };
  };

  public getMany = async (
    resource: string,
    params: GetManyParams
  ): Promise<GetManyResult> => {
    const queryName = `get${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    const queriesData = [];

    // Executes the queries
    for (const id of params.ids) {
      try {
        const queryData = (await this.graphql(query, { id }))[queryName];
        queriesData.push(queryData);
      } catch (e) {
        console.log(e);
      }
    }

    return {
      data: queriesData,
    };
  };

  public getManyReference = async (
    resource: string,
    params: GetManyReferenceParams
  ): Promise<GetManyReferenceResult> => {
    const target = params.target.split(".");

    // Target is used to build the filter
    // It must be like: queryName.resourceID
    if (target.length !== 2) {
      throw new Error("Data provider error");
    }

    const { filter, id, pagination, sort } = params;

    if (!filter[target[0]]) {
      filter[target[0]] = {};
    }

    filter[target[0]][target[1]] = id;

    return this.getList(resource, { pagination, sort, filter });
  };

  public create = async (
    resource: string,
    params: CreateParams
  ): Promise<CreateResult> => {
    const queryName = `create${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    // Executes the query
    const queryData = (await this.graphql(query, { input: params.data }))[
      queryName
    ];

    return {
      data: queryData,
    };
  };

  public update = async (
    resource: string,
    params: UpdateParams
  ): Promise<UpdateResult> => {
    const queryName = `update${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    // Removes non editable fields
    const { data } = params;
    delete data._deleted;
    delete data._lastChangedAt;
    delete data.createdAt;
    delete data.updatedAt;

    // Executes the query
    const queryData = (await this.graphql(query, { input: data }))[queryName];

    return {
      data: queryData,
    };
  };

  // This may not work for API that uses DataStore because
  // DataStore works with a _version field that needs to be properly set
  public updateMany = async (
    resource: string,
    params: UpdateManyParams
  ): Promise<UpdateManyResult> => {
    const queryName = `update${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    // Removes non editable fields
    const { data } = params;
    delete data._deleted;
    delete data._lastChangedAt;
    delete data.createdAt;
    delete data.updatedAt;

    const ids = [];

    // Executes the queries
    for (const id of params.ids) {
      try {
        await this.graphql(query, { input: { ...data, id } });
        ids.push(id);
      } catch (e) {
        console.log(e);
      }
    }

    return {
      data: ids,
    };
  };

  public delete = async (
    resource: string,
    params: DeleteParams
  ): Promise<DeleteResult> => {
    const queryName = `delete${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    const { id, previousData } = params;
    const data = { id } as Record<string, unknown>;

    if (previousData._version) {
      data._version = previousData._version;
    }

    // Executes the query
    const queryData = (await this.graphql(query, { input: data }))[queryName];

    return {
      data: queryData,
    };
  };

  public deleteMany = async (
    resource: string,
    params: DeleteManyParams
  ): Promise<DeleteManyResult> => {
    const queryName = `delete${
      resource.charAt(0).toUpperCase() + resource.slice(1, -1)
    }`;
    const query = this.getQuery(queryName);

    const ids = [];

    // Executes the queries
    for (const id of params.ids) {
      try {
        await this.graphql(query, { input: { id } });
        ids.push(id);
      } catch (e) {
        console.log(e);
      }
    }

    return {
      data: ids,
    };
  };

  public getQuery(queryName: string): string {
    if (this.queries[queryName]) {
      return this.queries[queryName];
    }

    if (this.mutations[queryName]) {
      return this.mutations[queryName];
    }

    console.log(`Could not find query ${queryName}`);

    throw new Error("Data provider error");
  }

  public async graphql(
    query: string,
    variables: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const queryResult = <GraphQLResult>await API.graphql({
      query,
      variables,
      authMode: this.authMode,
    });

    if (queryResult.errors || !queryResult.data) {
      throw new Error("Data provider error");
    }

    return queryResult.data;
  }
}
