/* eslint-disable no-await-in-loop */
/* eslint-disable no-plusplus */
import { DEAD_ADDRESS, ONE_WEEK } from "@utils/constants"
import { StandardAccounts } from "@utils/machines"
import { expect } from "chai"
import { ethers } from "hardhat"
import { BN, increaseTime, simpleToExactAmount } from "index"
import {
    EmissionsController,
    EmissionsController__factory,
    MockERC20,
    MockERC20__factory,
    MockNexus,
    MockNexus__factory,
    MockRewardsDistributionRecipient,
    MockRewardsDistributionRecipient__factory,
    MockStakingContract,
    MockStakingContract__factory,
} from "types/generated"

describe("EmissionsController", async () => {
    let sa: StandardAccounts
    let nexus: MockNexus
    let staking1: MockStakingContract
    let staking2: MockStakingContract
    let rewardToken: MockERC20
    const dials: MockRewardsDistributionRecipient[] = []
    let emissionsController: EmissionsController
    const totalRewards = simpleToExactAmount(40000000)
    const weeklyRewards = totalRewards.div(312)

    const deployEmissionsController = async (): Promise<void> => {
        // staking contracts
        staking1 = await new MockStakingContract__factory(sa.default.signer).deploy()
        staking2 = await new MockStakingContract__factory(sa.default.signer).deploy()

        nexus = await new MockNexus__factory(sa.default.signer).deploy(sa.governor.address, DEAD_ADDRESS, DEAD_ADDRESS)
        rewardToken = await new MockERC20__factory(sa.default.signer).deploy(
            "Reward",
            "RWD",
            18,
            sa.default.address,
            simpleToExactAmount(100000000),
        )

        // Deploy dials
        for (let i = 0; i < 3; i++) {
            const newDial = await new MockRewardsDistributionRecipient__factory(sa.default.signer).deploy(rewardToken.address, DEAD_ADDRESS)
            dials.push(newDial)
        }

        emissionsController = await new EmissionsController__factory(sa.default.signer).deploy(
            nexus.address,
            [staking1.address, staking2.address],
            rewardToken.address,
            totalRewards,
        )
        const dialAddresses = dials.map((dial) => dial.address)
        await rewardToken.approve(emissionsController.address, totalRewards)
        await emissionsController.initialize(dialAddresses)
    }

    before(async () => {
        const accounts = await ethers.getSigners()
        sa = await new StandardAccounts().initAccounts(accounts)
        console.log(`user 1 ${sa.dummy1.address}`)
        console.log(`user 2 ${sa.dummy2.address}`)
        console.log(`user 3 ${sa.dummy3.address}`)
    })

    describe("distribute rewards", () => {
        const user1Staking1Votes = simpleToExactAmount(100)
        const user1Staking2Votes = simpleToExactAmount(200)
        const user2Staking1Votes = simpleToExactAmount(600)
        const user3Staking1Votes = simpleToExactAmount(300)
        beforeEach(async () => {
            await deployEmissionsController()
            await staking1.setVotes(sa.dummy1.address, user1Staking1Votes)
            await staking2.setVotes(sa.dummy1.address, user1Staking2Votes)
            await staking1.setVotes(sa.dummy2.address, user2Staking1Votes)
            await staking1.setVotes(sa.dummy3.address, user3Staking1Votes)
            await increaseTime(ONE_WEEK.mul(2))
        })
        context("change voting weights", () => {
            context("first voting period", () => {
                beforeEach(async () => {
                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 before").to.eq(0)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 before").to.eq(0)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 before").to.eq(0)
                })
                it("all user 1 to dial 1", async () => {
                    await emissionsController
                        .connect(sa.dummy1.signer)
                        .setVoterDialWeights([{ addr: dials[0].address, weight: simpleToExactAmount(1) }])

                    const tx = await emissionsController.distributeRewards()

                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, weeklyRewards)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, weeklyRewards)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(weeklyRewards)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(0)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(0)
                })
                it("all user 1 to dial 1, all user 2 to dial 2", async () => {
                    await emissionsController
                        .connect(sa.dummy1.signer)
                        .setVoterDialWeights([{ addr: dials[0].address, weight: simpleToExactAmount(1) }])
                    await emissionsController
                        .connect(sa.dummy2.signer)
                        .setVoterDialWeights([{ addr: dials[1].address, weight: simpleToExactAmount(1) }])

                    const tx = await emissionsController.distributeRewards()

                    // User 1 has 300 of the 900 votes (1/3)
                    const dial1 = weeklyRewards.div(3)
                    // User 2 has 600 of the 900 votes (2/3)
                    const dial2 = weeklyRewards.mul(2).div(3)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(dial1)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(dial2)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(0)
                })
                it("user 1 50/50 dial 1 & 2, user 2 50/50 dial 1 & 2", async () => {
                    await emissionsController.connect(sa.dummy1.signer).setVoterDialWeights([
                        { addr: dials[0].address, weight: simpleToExactAmount(5, 17) },
                        { addr: dials[1].address, weight: simpleToExactAmount(5, 17) },
                    ])
                    await emissionsController.connect(sa.dummy2.signer).setVoterDialWeights([
                        { addr: dials[0].address, weight: simpleToExactAmount(5, 17) },
                        { addr: dials[1].address, weight: simpleToExactAmount(5, 17) },
                    ])

                    const tx = await emissionsController.distributeRewards()

                    // User 1 and 2 split their votes 50/50
                    const dial1 = weeklyRewards.div(2)
                    const dial2 = weeklyRewards.div(2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(dial1)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(dial2)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(0)
                })
                it("user 1 20/80 dial 1 & 2, user 2 all dial 3", async () => {
                    await emissionsController.connect(sa.dummy1.signer).setVoterDialWeights([
                        { addr: dials[0].address, weight: simpleToExactAmount(2, 17) },
                        { addr: dials[1].address, weight: simpleToExactAmount(8, 17) },
                    ])
                    await emissionsController
                        .connect(sa.dummy2.signer)
                        .setVoterDialWeights([{ addr: dials[2].address, weight: simpleToExactAmount(1) }])

                    const tx = await emissionsController.distributeRewards()

                    // User 1 20% of 300 votes
                    const dial1 = weeklyRewards.mul(300).div(5).div(900)
                    // User 1 80% of 300 votes
                    const dial2 = weeklyRewards.mul(300).mul(4).div(5).div(900)
                    // User 2 600 votes
                    const dial3 = weeklyRewards.mul(600).div(900)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, dial3)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, dial3)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(dial1)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(dial2)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(dial3)
                })
            })
            context.only("second voting period", () => {
                // Users previous votes
                // User 1 300 20% dial 1, 80% dial 2
                // User 2 600 100% dial 3
                let rewardsDial1ZBefore: BN
                let rewardsDial2ZBefore: BN
                let rewardsDial3ZBefore: BN
                beforeEach(async () => {
                    await emissionsController.connect(sa.dummy1.signer).setVoterDialWeights([
                        { addr: dials[0].address, weight: simpleToExactAmount(2, 17) },
                        { addr: dials[1].address, weight: simpleToExactAmount(8, 17) },
                    ])
                    await emissionsController
                        .connect(sa.dummy2.signer)
                        .setVoterDialWeights([{ addr: dials[2].address, weight: simpleToExactAmount(1) }])

                    await emissionsController.distributeRewards()
                    rewardsDial1ZBefore = await rewardToken.balanceOf(dials[0].address)
                    rewardsDial2ZBefore = await rewardToken.balanceOf(dials[1].address)
                    rewardsDial3ZBefore = await rewardToken.balanceOf(dials[2].address)
                    await increaseTime(ONE_WEEK)
                })
                it("User 1 changes weights to 80/20 dial 1 & 2", async () => {
                    await emissionsController.connect(sa.dummy1.signer).setVoterDialWeights([
                        { addr: dials[0].address, weight: simpleToExactAmount(8, 17) },
                        { addr: dials[1].address, weight: simpleToExactAmount(2, 17) },
                    ])

                    const tx = await emissionsController.distributeRewards()

                    // User 1 80% of 300 votes
                    const dial1 = weeklyRewards.mul((300 * 4) / 5).div(900)
                    // User 1 20% of 300 votes
                    const dial2 = weeklyRewards.mul(300 / 5).div(900)
                    // User 2 600 votes
                    const dial3 = weeklyRewards.mul(600).div(900)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, dial3)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, dial3)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore.add(dial1))
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore.add(dial2))
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(rewardsDial3ZBefore.add(dial3))
                })
                it("User 1 removes 20% to dial 1", async () => {
                    await emissionsController
                        .connect(sa.dummy1.signer)
                        .setVoterDialWeights([{ addr: dials[1].address, weight: simpleToExactAmount(8, 17) }])

                    const tx = await emissionsController.distributeRewards()

                    // Total votes is 900 - 20% * 300 = 900 - 60 = 840
                    // User 1 80% of 300 votes
                    const dial2 = weeklyRewards.mul((300 * 4) / 5).div(840)
                    // User 2 600 votes
                    const dial3 = weeklyRewards.mul(600).div(840)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, dial3)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, dial3)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore.add(dial2))
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(rewardsDial3ZBefore.add(dial3))
                })
                it("User 1 changes all to dial 3", async () => {
                    await emissionsController
                        .connect(sa.dummy1.signer)
                        .setVoterDialWeights([{ addr: dials[2].address, weight: simpleToExactAmount(1) }])

                    const tx = await emissionsController.distributeRewards()

                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, weeklyRewards)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, weeklyRewards)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(
                        rewardsDial3ZBefore.add(weeklyRewards),
                    )
                })
                it("User 3 all weight on dial 1", async () => {
                    expect(await emissionsController.totalDialVotes(), "total vote before").to.eq(simpleToExactAmount(900))
                    await emissionsController
                        .connect(sa.dummy3.signer)
                        .setVoterDialWeights([{ addr: dials[0].address, weight: simpleToExactAmount(1) }])
                    expect(await emissionsController.totalDialVotes(), "total vote after").to.eq(simpleToExactAmount(1200))

                    const tx = await emissionsController.distributeRewards()

                    // User 1 20% of 300 votes + User 3 300 votes
                    const dial1 = weeklyRewards.mul(300 + 300 / 5).div(1200)
                    // User 1 80% of 300 votes
                    const dial2 = weeklyRewards.mul((300 * 4) / 5).div(1200)
                    // User 2 600 votes
                    const dial3 = weeklyRewards.mul(600).div(1200)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, dial3)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, dial3)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore.add(dial1))
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore.add(dial2))
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(rewardsDial3ZBefore.add(dial3))
                })
                it("User 3 all weight on dial 2", async () => {
                    expect(await emissionsController.totalDialVotes(), "total vote before").to.eq(simpleToExactAmount(900))
                    await emissionsController
                        .connect(sa.dummy3.signer)
                        .setVoterDialWeights([{ addr: dials[1].address, weight: simpleToExactAmount(1) }])
                    expect(await emissionsController.totalDialVotes(), "total vote after").to.eq(simpleToExactAmount(1200))

                    const tx = await emissionsController.distributeRewards()

                    // User 1 20% of 300 votes + User 3 300 votes
                    const dial1 = weeklyRewards.mul(300 / 5).div(1200)
                    // User 1 80% of 300 votes, User 3 300 votes
                    const dial2 = weeklyRewards.mul(300 + (300 * 4) / 5).div(1200)
                    // User 2 600 votes
                    const dial3 = weeklyRewards.mul(600).div(1200)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[2].address, dial3)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[2].address, dial3)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore.add(dial1))
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore.add(dial2))
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(rewardsDial3ZBefore.add(dial3))
                })
                it("User 2 removes all votes to dial 3", async () => {
                    await emissionsController.connect(sa.dummy2.signer).setVoterDialWeights([])

                    const tx = await emissionsController.distributeRewards()

                    // User 1 20% of 300 votes
                    const dial1 = weeklyRewards.mul(300 / 5).div(300)
                    // User 1 80% of 300 votes
                    const dial2 = weeklyRewards.mul((300 * 4) / 5).div(300)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, dial1)
                    await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, dial2)

                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[0].address, dial1)
                    await expect(tx).to.emit(rewardToken, "Transfer").withArgs(emissionsController.address, dials[1].address, dial2)

                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 after").to.eq(rewardsDial1ZBefore.add(dial1))
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 after").to.eq(rewardsDial2ZBefore.add(dial2))
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 after").to.eq(rewardsDial3ZBefore)
                })
            })
        })
        context("Change voting power", () => {
            context("first voting period", () => {
                beforeEach(async () => {
                    expect(await rewardToken.balanceOf(dials[0].address), "rewards dial 1 before").to.eq(0)
                    expect(await rewardToken.balanceOf(dials[1].address), "rewards dial 2 before").to.eq(0)
                    expect(await rewardToken.balanceOf(dials[2].address), "rewards dial 3 before").to.eq(0)
                })
            })
            it("User 2 increases voting power")
            it("User 2 reduces voting power")
            it("User 2 delegates voting voting power to User 3")
        })
    })
    describe("add dial", () => {})
    describe("remove dial", () => {})
})
