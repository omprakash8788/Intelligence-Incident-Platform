export type NodeEnvironment =
  | "development"
  | "test"
  | "production";

export interface ApplicationConfig {
  nodeEnv: NodeEnvironment;
  port: number;
}

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  connectTimeoutMs: number;
}

export interface SecurityConfig {
  requestBodyLimit: string;
}

export interface AppConfig {
  app: ApplicationConfig;
  postgres: PostgresConfig;

  redis: RedisConfig;
  security: SecurityConfig;
}

