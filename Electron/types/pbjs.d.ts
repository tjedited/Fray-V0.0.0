declare module 'protobufjs-cli/pbjs.js' {
  const pbjs: {
    main(args: string[], callback: (error: Error | null, output?: string) => void): number | void;
  };
  export default pbjs;
}
