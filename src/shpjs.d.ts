declare module 'shpjs' {
  export function parseZip(data:ArrayBuffer):Promise<any>;
  const shp:{parseZip:typeof parseZip};
  export default shp;
}
