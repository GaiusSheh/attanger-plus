import hooks from "./hooks";

export class Addon {
  readonly rootURI: string;
  readonly data = {
    initialized: false,
  };
  readonly hooks = hooks;

  constructor(rootURI: string) {
    this.rootURI = rootURI;
  }
}
