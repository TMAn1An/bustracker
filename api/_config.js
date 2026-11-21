// ---------------------------------------------------------------------------------------------
//  Your university: change these when you fork the project (see README → "Use it at your university").
//  Branding in the pages (name, logo, colours) is listed in the same README section.
// ---------------------------------------------------------------------------------------------
export const SITE = {
  name: 'IUBAT Bus Tracker',
  university: 'International University of Business Agriculture and Technology',
  // Where every route ends (morning trips go here, evening trips start here)
  campus: { name: 'IUBAT Campus', lat: 23.8882231, lng: 90.3906409 },
  // Public address of your deployment (used as the contact for push notification services)
  url: process.env.SITE_URL || 'https://bustracker.iubat.workers.dev',
  // Times are Bangladesh time (UTC+6, no daylight saving). For another country see README → "Time zone".
  utcOffsetHours: 6,
};
