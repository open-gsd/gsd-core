'use strict';

const sandboxVrStores = [
  {
    id: 'san-francisco',
    slug: 'sanfrancisco',
    market: 'San Francisco, CA',
    venue: 'SF Market St',
    address: '767B Market Street, San Francisco, CA 94103',
    coordinates: { lat: 37.78621, lon: -122.404 },
    hours: ['Mon-Thu 10AM-10PM', 'Fri-Sun 10AM-11PM'],
    priceSummary: 'From $39',
    sourcePath: 'https://sandboxvr.com/sanfrancisco/location'
  },
  {
    id: 'london',
    slug: 'london',
    market: 'London, UK',
    venue: 'Covent Garden',
    address: 'The Post Building, Museum Street, London, WC1A 1PB',
    coordinates: { lat: 51.51667, lon: -0.1243 },
    hours: ['Mon-Fri 10AM-11:30PM', 'Sat 10AM-12AM', 'Sun 10AM-11PM'],
    priceSummary: '£29.50-£54.50',
    sourcePath: 'https://sandboxvr.com/london/location'
  },
  {
    id: 'singapore',
    slug: 'singapore',
    market: 'Singapore',
    venue: 'Orchard Central',
    address: '181 Orchard Road, #05-31 Orchard Central, Singapore 238896',
    coordinates: { lat: 1.3008115, lon: 103.8396674 },
    hours: ['Mon-Thu 10:50AM-9:30PM', 'Fri-Sun 9:50AM-9:30PM'],
    priceSummary: 'S$48-S$65',
    sourcePath: 'https://sandboxvr.com/singapore/location'
  },
  {
    id: 'chicago-oakbrook',
    slug: 'chicago',
    market: 'Chicago, IL',
    venue: 'Oakbrook Center',
    address: '560 Oakbrook Center, Oak Brook, IL 60523',
    coordinates: { lat: 41.85129, lon: -87.9523 },
    hours: ['Mon-Thu 10AM-10PM', 'Fri-Sun 10AM-11PM'],
    priceSummary: '$39',
    sourcePath: 'https://sandboxvr.com/chicago/location'
  },
  {
    id: 'toronto',
    slug: 'toronto',
    market: 'Toronto, ON',
    venue: 'Toronto',
    address: '21 Wellesley Street West #1, Toronto, ON M4Y 0G7, Canada',
    coordinates: { lat: 43.6645, lon: -79.3852 },
    hours: ['Mon-Thu 12:40PM-9:30PM', 'Fri-Sat 12:40PM-12AM', 'Sun 10:10AM-10:40PM'],
    priceSummary: 'C$60-C$69',
    sourcePath: 'https://sandboxvr.com/toronto/location'
  },
  {
    id: 'dallas',
    slug: 'dallas',
    market: 'Dallas, TX',
    venue: 'Mockingbird',
    address: '5321 E. Mockingbird Lane, Ste. 110, Dallas, TX 75206',
    coordinates: { lat: 32.83669, lon: -96.7769 },
    hours: ['Mon-Thu 10AM-10PM', 'Fri-Sun 10AM-11PM'],
    priceSummary: 'From $39',
    sourcePath: 'https://sandboxvr.com/dallas/location'
  },
  {
    id: 'san-jose',
    slug: 'sanjose',
    market: 'San Jose, CA',
    venue: 'Westfield Valley Fair',
    address: '2855 Stevens Creek Blvd, #2721, Santa Clara, CA 95050',
    coordinates: { lat: 37.32591, lon: -121.945 },
    hours: ['Mon-Thu 10AM-10PM', 'Fri-Sun 10AM-12AM'],
    priceSummary: '$55-$65',
    sourcePath: 'https://sandboxvr.com/sanjose/location'
  },
  {
    id: 'vancouver',
    slug: 'vancouver',
    market: 'Vancouver, BC',
    venue: 'Vancouver',
    address: '12571 Bridgeport Rd, Unit 170, Richmond, BC V6V 1J4',
    coordinates: { lat: 49.1924912, lon: -123.0837784 },
    hours: ['Mon-Thu 2PM-8:45PM', 'Fri 2PM-11:45PM', 'Sat-Sun 10:15AM-11:45PM'],
    priceSummary: 'From C$39',
    sourcePath: 'https://sandboxvr.com/vancouver/location'
  }
];

const sandboxVrStoreIds = new Set(sandboxVrStores.map((store) => store.id));

module.exports = {
  sandboxVrStores,
  sandboxVrStoreIds
};
