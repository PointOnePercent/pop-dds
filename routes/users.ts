import axios from 'axios';
import { log } from '../helpers/log';
import { connectToDb, getDataFromDB } from '../helpers/db';
import { hash } from '../helpers/hash';
import config from '../config.json';

/**
 * Returns all users.
 */
export const getAllUsers = async (req, res) => {
    try {
        const users = await getDataFromDB('users');
        res.status(200).send(users);
    }
    catch (err) {
        res.status(err.code).send(err);
    }
}

/**
 * Returns particular user's data.
 * @param req.params.steamid
 */
export const getUser = async (req, res) => {
    try {
        const user = await getDataFromDB('users', { id: req.params.steamid });
        res.status(200).send(user);
    }
    catch (err) {
        res.status(err.code).send(err);
    }
}

const getUserGames = (userID:number, curatedGames:any, userGames:any) => new Promise(async (resolve, reject) =>{
    log.INFO(`--> [UPDATE] games of user ${userID}`);
    if (!userGames.data) {
        log.INFO(`- user ${ userID} has their profile set to private`)
        resolve([ ]);
        return;
    }

    let games = userGames.data.substring((userGames.data.indexOf('rgGames =')) + 9);
        games = games.substring(0, games.indexOf('];')+1).trim();
    try {
        games = JSON.parse(games);
    }
    catch(err) {
        log.INFO(`- user ${ userID} has their profile set to private`)
        log.INFO(games);
        resolve([ ]);
        return;
    }

    games = games.filter(game => !!curatedGames.find(cachedgame => cachedgame.id == game.appid))
        .map(game => {
            return {
                appid: game.appid,
                playtime_forever: game.hours_forever ? game.hours_forever.replace(',', '') : 0
            }
        })
    try {
        resolve(await getUserAchievements(userID, games));
    }
    catch(err) {
        reject([ ])
    }    
    return;
})

const getUserAchievements = (userID:number, games:object) => new Promise((resolve, reject) => {
    log.INFO(`--> achievements of user ${ userID }`);

    const getAchievementsDetails = async (index:number) => {
        let gameID = games[index].appid;
        let url = `http://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?appid=${ gameID }&steamid=${ userID }&key=${ config.STEAM_KEY }&format=json`;
        let response;

        log.INFO(`-- game ${ gameID }`);
        try {
            response = await axios.get(url);

            let numberOfAllAchievements = response.data.playerstats.achievements.length;
            let numberOfUnlockedAchievements = response.data.playerstats.achievements.filter(achievement => achievement.achieved == 1).length;
            let lastUnlocked = 0;
            response.data.playerstats.achievements.map(achievement => 
                achievement.unlocktime > lastUnlocked
                    ? lastUnlocked = achievement.unlocktime
                    : null
            )
            let completionRate = 100*numberOfUnlockedAchievements/numberOfAllAchievements;
            
            games[index].completionRate = completionRate;
            games[index].lastUnlocked = lastUnlocked;
        }
        catch (err) {
            log.WARN(`--> game ${ gameID } - [ERROR] - ${ url }`);
            log.WARN(err);
            if (games[index+1]) {
                setTimeout(() => getAchievementsDetails(index + 1), config.DELAY);
            }
            else {
                log.INFO(`--> [UPDATE] achievements for ${ userID } [DONE]`);
                resolve(games);
                return;
            }
        }

        if (games[index+1]) {
            setTimeout(() => getAchievementsDetails(index + 1), config.DELAY);
        }
        else {
            log.INFO(`--> [UPDATE] achievements for ${ userID } [DONE]`);
            resolve(games);
        }
        
        // TODO logic for new completion event

        // if (completionRate === 100
        //     && Date.now() - (lastUnlocked*1000) <= 604800000
        //     && cache.log.filter(log => log.type == "complete" 
        //         && Number(log.player) === Number(cache.members[memberIndex].id) 
        //         && Number(log.game) === Number(cache.members[memberIndex].games[gameIndex].appid)).length == 0) 
        //     {
        //         cache.log.push({
        //             "date": lastUnlockedAchievement * 1000,
        //             "type": "complete",
        //             "player": cache.members[memberIndex].id,
        //             "game": cache.members[memberIndex].games[gameIndex].appid
        //         });
        //         console.log(`-- new 100% detected - adding to log file`);
        // }     
    }
    getAchievementsDetails(0);
})

const getUserRanking = (curatedGames, userGames) => new Promise(async(resolve, reject) => {
    let ranking = { };
    let rating;
    try {
        rating = await getDataFromDB('points');
    } 
    catch(err) {
        resolve(ranking)
    }
    rating.map(tier => ranking[tier.id] = 0);

    userGames
        .filter(game => game.completionRate == 100)
        .map(filteredgame => {
            let game = curatedGames.find(cachedgame => cachedgame.id == filteredgame.appid)
            game && ranking[game.rating]
                ? ranking[game.rating] += 1
                : ranking[game.rating] = 1;
        })
    resolve(ranking)
})

/**
 * Updates one particular user data.
 * @param req.params.steamid 
 */
export const updateUser = async (req, res) => {
    const curatedGames = await getDataFromDB('games');
    const userUrl = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.STEAM_KEY}&steamids=${req.params.steamid}`;
    const userGamesUrl = `https://steamcommunity.com/profiles/${req.params.steamid}/games/?tab=all`;
    const { client, db } = await connectToDb();
    let userData;
    let userGamesData;

    try {
        log.INFO(`--> [UPDATE] user ${req.params.steamid} [START]`) // TODO block too early updates
        userData = await axios.get(userUrl);
        userGamesData = await axios.get(userGamesUrl);
    }
    catch(err) {
        log.WARN(`--> [UPDATE] user ${req.params.steamid} [ERROR]`);
        log.WARN(err);
        res.status(err.code).send(err);
        return;
    }
    if (!userData || !userData.data || !userData.data.response || !userData.data.response.players) {
        log.WARN(`--> [UPDATE] updating user ${req.params.steamid} [ERROR]`);
        res.sendStatus(500);
        return;
    }
    res.status(202).send(`Initiated update of user ${req.params.steamid}.`);

    const gamesAsync = await getUserGames(req.params.steamid, curatedGames, userGamesData);
    const rankingAsync = await getUserRanking(curatedGames, gamesAsync);

    userData = userData.data.response.players[0];
    let user = { 
        id: req.params.steamid,
        name: userData.personaname,
        avatar: userData.avatarfull,
        url: `https://steamcommunity.com/profiles/${req.params.steamid}`,
        games: gamesAsync,
        ranking: rankingAsync,
        badges: [], // FIXME this removes all the badges
        private: userGamesData.data ? false : true,
        updated: Date.now()
    };

    db.collection('users').updateOne({ id: req.params.steamid }, {$set: user}, { upsert: true }, (err, data) => {
        if (err) {
            log.WARN(`--> [UPDATE] user ${req.params.steamid} [ERROR]`)
            log.WARN(err);
        }
        else {
            log.INFO(`--> [UPDATE] user ${req.params.steamid} [DONE]`)
        }
    });
    client.close();
}