'use strict';

const STORES = [
  {
    id: 'austin-tx',
    name: 'SandboxVR Austin',
    city: 'Austin',
    region: 'TX',
    address: '11701 Domain Blvd, Austin, TX 78758',
    coordinates: { x: 73, y: 52 },
    experiences: ['Deadwood Valley', 'Amber Sky 2088'],
    hours: 'Mon-Thu 2pm-10pm, Fri-Sun 10am-11pm'
  },
  {
    id: 'chicago-il',
    name: 'SandboxVR Chicago',
    city: 'Oak Brook',
    region: 'IL',
    address: 'Old Orchard / Oak Brook market area, Oak Brook, IL',
    coordinates: { x: 56, y: 28 },
    experiences: ['Squid Game Virtuals', 'Curse of Davy Jones'],
    hours: 'Daily 10am-11pm'
  },
  {
    id: 'las-vegas-nv',
    name: 'SandboxVR Las Vegas',
    city: 'Las Vegas',
    region: 'NV',
    address: 'The Grand Canal Shoppes, Las Vegas, NV',
    coordinates: { x: 18, y: 48 },
    experiences: ['Rebel Moon: The Descent', 'Seekers of the Shard'],
    hours: 'Daily 10am-12am'
  },
  {
    id: 'nashville-tn',
    name: 'SandboxVR Nashville',
    city: 'Nashville',
    region: 'TN',
    address: 'Downtown Nashville entertainment district',
    coordinates: { x: 64, y: 44 },
    experiences: ['Unbound Fighting League', 'Deadwood PHOBIA'],
    hours: 'Daily 11am-10pm'
  },
  {
    id: 'paramus-nj',
    name: 'SandboxVR Paramus',
    city: 'Paramus',
    region: 'NJ',
    address: 'Westfield Garden State Plaza, Paramus, NJ',
    coordinates: { x: 88, y: 26 },
    experiences: ['Alien Zoo', 'Deadwood Mansion'],
    hours: 'Daily 10am-9pm'
  },
  {
    id: 'philadelphia-pa',
    name: 'SandboxVR Philadelphia',
    city: 'King of Prussia',
    region: 'PA',
    address: 'King of Prussia Mall, King of Prussia, PA',
    coordinates: { x: 84, y: 31 },
    experiences: ['Amber Sky 2088', 'Squid Game Virtuals'],
    hours: 'Daily 10am-9pm'
  }
];

module.exports = {
  STORES
};
