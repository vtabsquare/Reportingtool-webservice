export type MapGeographyScope='auto'|'india'|'country'|'world';

export type LocalMapLocation={latitude:number;longitude:number;displayName:string};

const normalize=(value:any)=>String(value??'').trim().toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();

// Local centroids keep the most common India state analysis fully functional
// when the machine is offline or a public geocoder is rate limited. Exact
// latitude/longitude columns still take priority over these fallbacks.
const indiaStates:Record<string,[number,number,string]>={
  'andaman and nicobar islands':[11.7401,92.6586,'Andaman and Nicobar Islands'],'andhra pradesh':[15.9129,79.7400,'Andhra Pradesh'],
  'arunachal pradesh':[28.2180,94.7278,'Arunachal Pradesh'],'assam':[26.2006,92.9376,'Assam'],'bihar':[25.0961,85.3131,'Bihar'],
  'chandigarh':[30.7333,76.7794,'Chandigarh'],'chhattisgarh':[21.2787,81.8661,'Chhattisgarh'],'dadra and nagar haveli and daman and diu':[20.1809,73.0169,'Dadra and Nagar Haveli and Daman and Diu'],
  'delhi':[28.7041,77.1025,'Delhi'],'goa':[15.2993,74.1240,'Goa'],'gujarat':[22.2587,71.1924,'Gujarat'],'haryana':[29.0588,76.0856,'Haryana'],
  'himachal pradesh':[31.1048,77.1734,'Himachal Pradesh'],'jammu and kashmir':[33.7782,76.5762,'Jammu and Kashmir'],'jharkhand':[23.6102,85.2799,'Jharkhand'],
  'karnataka':[15.3173,75.7139,'Karnataka'],'kerala':[10.8505,76.2711,'Kerala'],'ladakh':[34.1526,77.5771,'Ladakh'],'lakshadweep':[10.5667,72.6417,'Lakshadweep'],
  'madhya pradesh':[22.9734,78.6569,'Madhya Pradesh'],'maharashtra':[19.7515,75.7139,'Maharashtra'],'manipur':[24.6637,93.9063,'Manipur'],
  'meghalaya':[25.4670,91.3662,'Meghalaya'],'mizoram':[23.1645,92.9376,'Mizoram'],'nagaland':[26.1584,94.5624,'Nagaland'],'odisha':[20.9517,85.0985,'Odisha'],
  'orissa':[20.9517,85.0985,'Odisha'],'puducherry':[11.9416,79.8083,'Puducherry'],'pondicherry':[11.9416,79.8083,'Puducherry'],'punjab':[31.1471,75.3412,'Punjab'],
  'rajasthan':[27.0238,74.2179,'Rajasthan'],'sikkim':[27.5330,88.5122,'Sikkim'],'tamil nadu':[11.1271,78.6569,'Tamil Nadu'],'telangana':[18.1124,79.0193,'Telangana'],
  'tripura':[23.9408,91.9882,'Tripura'],'uttar pradesh':[26.8467,80.9462,'Uttar Pradesh'],'uttarakhand':[30.0668,79.0193,'Uttarakhand'],
  'uttaranchal':[30.0668,79.0193,'Uttarakhand'],'west bengal':[22.9868,87.8550,'West Bengal']
};

const countries:Record<string,[number,number,string]>={
  'india':[20.5937,78.9629,'India'],'united states':[39.8283,-98.5795,'United States'],'usa':[39.8283,-98.5795,'United States'],
  'united states of america':[39.8283,-98.5795,'United States'],'canada':[56.1304,-106.3468,'Canada'],'mexico':[23.6345,-102.5528,'Mexico'],
  'brazil':[-14.2350,-51.9253,'Brazil'],'argentina':[-38.4161,-63.6167,'Argentina'],'united kingdom':[55.3781,-3.4360,'United Kingdom'],
  'uk':[55.3781,-3.4360,'United Kingdom'],'france':[46.2276,2.2137,'France'],'germany':[51.1657,10.4515,'Germany'],'italy':[41.8719,12.5674,'Italy'],
  'spain':[40.4637,-3.7492,'Spain'],'netherlands':[52.1326,5.2913,'Netherlands'],'russia':[61.5240,105.3188,'Russia'],'china':[35.8617,104.1954,'China'],
  'japan':[36.2048,138.2529,'Japan'],'south korea':[35.9078,127.7669,'South Korea'],'australia':[-25.2744,133.7751,'Australia'],
  'new zealand':[-40.9006,174.8860,'New Zealand'],'indonesia':[-0.7893,113.9213,'Indonesia'],'singapore':[1.3521,103.8198,'Singapore'],
  'malaysia':[4.2105,101.9758,'Malaysia'],'united arab emirates':[23.4241,53.8478,'United Arab Emirates'],'uae':[23.4241,53.8478,'United Arab Emirates'],
  'saudi arabia':[23.8859,45.0792,'Saudi Arabia'],'south africa':[-30.5595,22.9375,'South Africa'],'nigeria':[9.0820,8.6753,'Nigeria'],
  'egypt':[26.8206,30.8025,'Egypt'],'kenya':[-0.0236,37.9062,'Kenya']
};

export function resolveLocalMapLocation(query:string):LocalMapLocation|undefined{
  const parts=String(query||'').split(',').map(normalize).filter(Boolean);
  if(!parts.length)return undefined;
  const first=parts[0];
  const state=indiaStates[first];
  if(state&&(parts.length===1||parts.slice(1).some(part=>part==='india')))return{latitude:state[0],longitude:state[1],displayName:`${state[2]}, India`};
  const country=countries[first];
  if(country&&parts.length===1)return{latitude:country[0],longitude:country[1],displayName:country[2]};
  return undefined;
}

export function buildMapLocationQuery(values:any[],scope:MapGeographyScope='auto',defaultCountry=''){
  const parts:string[]=[];
  for(const value of values){const text=String(value??'').trim();if(text&&!parts.some(existing=>normalize(existing)===normalize(text)))parts.push(text)}
  const country=scope==='india'?'India':scope==='country'?defaultCountry.trim():'';
  if(country&&!parts.some(existing=>normalize(existing)===normalize(country)))parts.push(country);
  return parts.join(', ');
}

export function inferMapRole(field:string):'latitude'|'longitude'|'country'|'region'|'postalCode'|'geometry'|'location'|undefined{
  const name=normalize(field.split('.').slice(-1)[0]);
  if(/^(latitude|lat|y coordinate|y)$/.test(name))return'latitude';
  if(/^(longitude|long|lon|lng|x coordinate|x)$/.test(name))return'longitude';
  if(/(^| )(country|nation|country name|country code)($| )/.test(name))return'country';
  if(/(^| )(state|province|region|territory|state name|province name)($| )/.test(name))return'region';
  if(/(^| )(postal|postcode|postal code|zip|zip code|pincode|pin code)($| )/.test(name))return'postalCode';
  if(/(^| )(geometry|geojson|shape|wkt)($| )/.test(name))return'geometry';
  if(/(^| )(city|town|village|district|address|location|place)($| )/.test(name))return'location';
  return undefined;
}
