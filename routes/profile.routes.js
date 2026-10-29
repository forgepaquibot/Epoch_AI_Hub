const express = require('express');
const requireUser = require('../middleware/requireUser');
const { sqlGet } = require('../db/database');

const router = express.Router();

router.get('/profile', requireUser, async (req, res, next) => {
  try {
    const user = await sqlGet(
      `SELECT user_id, username, created_at, auth0_sub
         FROM users
        WHERE user_id = ?`,
      [req.session.user.id]
    );

    if (!user) {
      return res.status(404).render('errors/404', {
        message: 'User not found.'
      });
    }

    return res.render('profile', {
      title: 'Profile',
      user,
      auth0Profile: req.oidc?.user || null
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;